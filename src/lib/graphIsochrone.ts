// Graph-based isochrone via MOTIS /api/experimental/one-to-many-intermodal.
//
// For each grid cell in the origin's reach-bbox we ask MOTIS for the actual
// transit+street duration from the origin to that cell. The resulting
// per-cell durations form a field we contour at the maxMinutes threshold.
// This is what OTP2 / Valhalla / r5 do under the hood — and crucially,
// the street router knows rivers have no footbridges, rail yards have no
// crossings etc., so the polygon shape is physically meaningful.
//
// Cost vs. the previous Euclidean-disk approximation:
//   - ~0.3s per 1024-cell batch on a localhost MOTIS
//   - Walk 30min ≈ 15×15km bbox at 150m cells ≈ ~10k cells ≈ 10 batches ≈ ~1-2s
//   - Bike 60min ≈ 30×30km at 250m cells ≈ ~15k cells ≈ ~2-3s
//   - Budgets past ~75 min get painful; caller should warn or coarsen further.
import { contours } from "d3-contour";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import buffer from "@turf/buffer";
import cleanCoords from "@turf/clean-coords";
import { featureCollection, polygon as tpoly } from "@turf/helpers";
import rewind from "@turf/rewind";
import truncate from "@turf/truncate";
import union from "@turf/union";
import type { Mode, OneToManyIntermodalResponse } from "@motis-project/motis-client";
import { oneToManyIntermodalPost, oneToManyPost, motisTimeoutSignal } from "@/lib/motis";
import { mapMotis } from "@/lib/motisLimiter";
import type { StreetMode } from "@/lib/types";

const MAX_MANY_PER_REQUEST = 1024; // matches timetable.onetomany_max_many

const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

// Cell size in meters. Scales with budget because bbox area scales
// ~quadratically with reach (rail anchors push bbox far out at large
// budgets). Constant 60m was fine at 30min (~15k cells, ~2s graph),
// but at 60min walk the bbox grows to 40-60km wide → 400-700k cells
// at 60m → 15-20s graph. Stepping to 100m at 60min cuts cell count
// 3× and graph time ~linearly. Downstream turf buffer(0)/union
// canonicalization smooths cell-grid staircase artifacts enough that
// the displayed outline looks about the same regardless of source
// cell size at display scale.
function cellSizeM(mode: StreetMode, maxMinutes: number): number {
  const base = mode === "bike" ? 90 : 60;
  if (maxMinutes <= 30) return base;
  if (maxMinutes <= 45) return Math.round(base * 1.4);
  return Math.round(base * 2);
}

// Worst-case transit reach for bbox sizing when the caller doesn't
// supply one. Regional Rail tops out around 55 km/h in this system.
// Cells outside the real reach come back null and contribute -Inf to
// the field, which is fine.
const TRANSIT_KMH_CEILING = 55;

export async function graphIsochrone(args: {
  origin: { lat: number; lon: number };
  maxMinutes: number;
  mode: StreetMode;
  // Pass one time for a single-instant isochrone, or multiple times to
  // get a "best-case over the day" polygon — we take the min duration
  // per cell across all provided times before contouring.
  times: string[];
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  // Extra reach anchors — typically reachable transit stops (e.g.
  // Regional Rail stations) where `one-to-many-intermodal` misses the
  // connection but `one-to-all` correctly reports the arrival time.
  // Each anchor gets a walking-reach disk rasterized into the field
  // at radius (maxMinutes - reachedAtMinutes) * walk-speed.
  reachAnchors?: Array<{ lat: number; lon: number; reachedAtMinutes: number }>;
  // Forward to MOTIS intermodal. Default to ["TRANSIT"] (all modes)
  // when omitted so existing callers don't change.
  transitModes?: Mode[];
}): Promise<FeatureCollection<Polygon | MultiPolygon> | null> {
  const { origin, maxMinutes, mode, times, reachAnchors } = args;
  const transitModes = args.transitModes ?? (["TRANSIT"] as Mode[]);
  if (times.length === 0) return null;
  const streetMode: Mode = mode === "bike" ? "BIKE" : "WALK";

  const mPerLat = M_PER_DEG_LAT;
  const mPerLon = metersPerDegLon(origin.lat);

  // Reach bbox. If the caller supplied one (e.g. from a prior oneToAll
  // response) we use it verbatim. Otherwise we overshoot: worst case is
  // transit for the full budget at Regional Rail speed.
  const reachM = maxMinutes * (TRANSIT_KMH_CEILING * 1000) / 60;
  const bbox = args.bbox ?? {
    minLat: origin.lat - reachM / mPerLat,
    maxLat: origin.lat + reachM / mPerLat,
    minLon: origin.lon - reachM / mPerLon,
    maxLon: origin.lon + reachM / mPerLon,
  };

  const cellM = cellSizeM(mode, maxMinutes);
  const widthM = (bbox.maxLon - bbox.minLon) * mPerLon;
  const heightM = (bbox.maxLat - bbox.minLat) * mPerLat;
  const nx = Math.max(16, Math.round(widthM / cellM));
  const ny = Math.max(16, Math.round(heightM / cellM));

  // Build target list — cell centers. One string per cell in row-major.
  const targets: string[] = new Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const lat = bbox.minLat + ((y + 0.5) / ny) * (bbox.maxLat - bbox.minLat);
    for (let x = 0; x < nx; x++) {
      const lon = bbox.minLon + ((x + 0.5) / nx) * (bbox.maxLon - bbox.minLon);
      targets[y * nx + x] = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    }
  }

  // Durations per cell in seconds; Infinity = unreachable / not returned.
  const durationsSec = new Float64Array(nx * ny);
  durationsSec.fill(Infinity);

  const batchCount = Math.ceil(targets.length / MAX_MANY_PER_REQUEST);
  const batchIdx = Array.from({ length: batchCount }, (_, i) => i);

  // For each sample time, query MOTIS and keep the min duration per cell.
  // Times run sequentially so we don't saturate MOTIS's thread pool —
  // each time's batches flow through the shared motisLimiter.
  for (const time of times) {
    await mapMotis(batchIdx, async (bi) => {
      const start = bi * MAX_MANY_PER_REQUEST;
      const end = Math.min(targets.length, start + MAX_MANY_PER_REQUEST);
      const slice = targets.slice(start, end);
      const { data, error } = await oneToManyIntermodalPost({
        signal: motisTimeoutSignal(),
        body: {
          one: `${origin.lat},${origin.lon}`,
          many: slice,
          time,
          maxTravelTime: maxMinutes,
          arriveBy: false,
          transitModes,
          preTransitModes: [streetMode],
          postTransitModes: [streetMode],
          directMode: streetMode,
          // Matching distance: how far a target cell can be from a walkable
          // OSM way and still get counted as reachable. MUST stay tight —
          // beyond ~20m, MOTIS's foot profile snaps to the RiverLink ferry
          // edge (`route=ferry; foot=yes` in OSM), which makes mid-Delaware
          // cells "walkable" across the river in ~15 min. 18m is the floor
          // that still lets real urban mid-block cells match (streets in
          // Philly are spaced ~80-100m, and even the tightest probes —
          // Univ City, Fairmount Park — snap at 18m).
          maxMatchingDistance: 18,
          // Cap at 3 transfers — matches a "realistic trip" envelope
          // (chains beyond 3 vehicles are rarely actually taken).
          maxTransfers: 3,
          useRoutedTransfers: true,
          // Street-Dijkstra cost scales sharply with these. Bike is ~6x more
          // expensive per minute than walk (bike graph is denser and faster,
          // so the search frontier expands much wider in the same budget).
          // Measured: walk pre=15 ≈ 1.5s/batch, bike pre=15 ≈ 8.5s/batch.
          // Bike pre=5 drops to 1.1s/batch and still covers downtown transit
          // density (5 min bike ≈ 1.8km — hits any nearby subway/regional).
          maxPreTransitTime: (mode === "bike" ? 5 : 15) * 60,
          maxPostTransitTime: (mode === "bike" ? 5 : 15) * 60,
          // Direct (no-transit) path cap. For bike the direct leg IS the
          // main use case (bike alone is often faster than bike+transit),
          // so we let it ride the full budget. For walk, cap at 45 min —
          // beyond that, transit always wins.
          maxDirectTime: Math.min(maxMinutes, mode === "bike" ? maxMinutes : 45) * 60,
        },
      });
      if (error) {
        // MOTIS rejects oversized batches (`onetomany_max_many` cap); log
        // loudly so the operator sees the cap mismatch instead of silently
        // returning a sparse polygon.
        console.error(`[graphIsochrone] one-to-many-intermodal batch failed: ${JSON.stringify(error).slice(0, 300)}`);
        return;
      }
      const j = data as OneToManyIntermodalResponse;
      const street = j.street_durations ?? [];
      const transit = j.transit_durations ?? [];
      for (let i = 0; i < slice.length; i++) {
        let best = Infinity;
        const sd = street[i]?.duration;
        if (sd != null && sd < best) best = sd;
        const pset = transit[i] ?? [];
        for (const p of pset) {
          if (p.duration != null && p.duration < best) best = p.duration;
        }
        const idx = start + i;
        if (best < durationsSec[idx]) durationsSec[idx] = best;
      }
    });
  }

  // Street-routed reach from each reach anchor (typically Regional
  // Rail stations that intermodal couldn't route to). For each anchor
  // we ask MOTIS `/api/v1/one-to-many` with mode=WALK to every grid
  // cell within the anchor's remaining walking budget — this gives
  // real street distances, not the Euclidean circle the previous
  // implementation drew. Adds ~1-3s cold per query (cached at the
  // polygon level upstream, so repeat clicks are free).
  if (reachAnchors && reachAnchors.length > 0) {
    // Street-routed anchor walks.
    //
    // For each late-budget anchor (reached > half the total budget, so
    // we skip close-in city-center stations whose reach is already
    // covered by intermodal), call MOTIS one-to-many WALK/BIKE to every
    // cell inside the Euclidean walk/bike budget. Cells MOTIS can snap
    // and route to within the budget get that street duration; cells it
    // can't stay at Infinity.
    //
    // The late-budget cutoff keeps big early-budget disks (2-3km
    // radius) from ever running — those would cross rivers via the
    // ferry/bridge snap that the 80m match distance permits. Suburban
    // stations' tiny disks (< 500m) are safely away from water.
    //
    // Disk radius uses crow-flies max (no detour), because MOTIS's
    // duration response is the real filter. Using a detour factor here
    // shrinks the candidate set too aggressively and MOTIS-reachable
    // near-straight cells get silently dropped (probed at Narberth: a
    // 1.3× detour cuts 25% of the 8-min budget-fit cells).
    //
    // Bike mode: reach is ~3× walk, so a 20-min remaining budget at
    // Fort Washington goes from a ~1.6km walk radius to a ~5km bike
    // radius — without this, bike-mode anchor disks were effectively
    // walk-sized and far-out rail stations appeared unreachable by
    // bike even when 20-30 min of riding were still available.
    const walkSpeedMPerMin = (5 * 1000) / 60; // 5 km/h
    const bikeSpeedMPerMin = (15 * 1000) / 60; // 15 km/h
    const effectiveMPerMin = mode === "bike" ? bikeSpeedMPerMin : walkSpeedMPerMin;
    const mLat = M_PER_DEG_LAT;
    const mLon = metersPerDegLon(origin.lat);
    const anchorBudgetCutoff = maxMinutes / 2;

    const fromGridLatLon = (x: number, y: number): [number, number] => [
      bbox.minLat + ((y + 0.5) / ny) * (bbox.maxLat - bbox.minLat),
      bbox.minLon + ((x + 0.5) / nx) * (bbox.maxLon - bbox.minLon),
    ];

    const rasterAnchor = async (a: NonNullable<typeof reachAnchors>[number]): Promise<void> => {
      const remainingMin = maxMinutes - a.reachedAtMinutes;
      if (remainingMin <= 0) return;
      if (a.reachedAtMinutes <= anchorBudgetCutoff) return;
      const radiusM = remainingMin * effectiveMPerMin;
      const reachedSec = a.reachedAtMinutes * 60;
      const radiusM2 = radiusM * radiusM;
      const ymin = Math.max(0, Math.floor(((a.lat - radiusM / mLat) - bbox.minLat) / (bbox.maxLat - bbox.minLat) * ny));
      const ymax = Math.min(ny - 1, Math.ceil(((a.lat + radiusM / mLat) - bbox.minLat) / (bbox.maxLat - bbox.minLat) * ny));
      const xmin = Math.max(0, Math.floor(((a.lon - radiusM / mLon) - bbox.minLon) / (bbox.maxLon - bbox.minLon) * nx));
      const xmax = Math.min(nx - 1, Math.ceil(((a.lon + radiusM / mLon) - bbox.minLon) / (bbox.maxLon - bbox.minLon) * nx));

      // Collect candidate cells (inside the Euclidean disk) with their
      // lat/lon (for routing) and Euclidean distance (for the detour-
      // reject filter below).
      type Target = { idx: number; lat: number; lon: number; euclM: number };
      const targets: Target[] = [];
      for (let y = ymin; y <= ymax; y++) {
        const [cellLat] = fromGridLatLon(0, y);
        const dLatM = (cellLat - a.lat) * mLat;
        const dLatM2 = dLatM * dLatM;
        if (dLatM2 > radiusM2) continue;
        for (let x = xmin; x <= xmax; x++) {
          const [, cellLon] = fromGridLatLon(x, 0);
          const dLonM = (cellLon - a.lon) * mLon;
          const distM2 = dLonM * dLonM + dLatM2;
          if (distM2 > radiusM2) continue;
          targets.push({
            idx: y * nx + x,
            lat: cellLat,
            lon: cellLon,
            euclM: Math.sqrt(distM2),
          });
        }
      }
      if (targets.length === 0) return;

      // MOTIS one-to-many street routing. Match distance + detour-ratio
      // filter work together: the match needs to be loose enough to
      // capture suburban streets (often 60-80m from a grid cell center
      // in outer PA towns — at 40m only 1% of cells near Eddington
      // station reach; at 80m, 45%+ reach). But looser match also lets
      // cells over water snap to walkable edges hundreds of meters
      // around, inflating the walkshed into rivers.
      //
      // Solution: 80m match for coverage, then reject cells whose
      // routed distance exceeds ~4× the Euclidean distance to the
      // anchor. `withDistance=true` tells MOTIS to return the routed
      // distance alongside duration.
      //
      // Threshold 4× balances two measured regimes:
      //   Mid-Delaware cells         :  5-12×  (rejected — spurious water snap)
      //   Suburban-side-of-rail-yard :  3-9×   (kept — legit walks around tracks)
      //   River-edge cells           :  ~4.3×  (borderline, usually rejected)
      //   Inland grid streets        :  1.2-1.7× (kept)
      // A tighter 2.5× killed the suburban-barrier cells (e.g. cells
      // across the rail yard from Bethayres station) even at 80m match,
      // leaving stations as isolated single-cell polygons.
      const DETOUR_REJECT_RATIO = 4.0;
      const streetDurations = new Array<number | undefined>(targets.length);
      const motisMode: Mode = mode === "bike" ? "BIKE" : "WALK";
      for (let start = 0; start < targets.length; start += MAX_MANY_PER_REQUEST) {
        const slice = targets.slice(start, start + MAX_MANY_PER_REQUEST);
        const { data, error } = await oneToManyPost({
          signal: motisTimeoutSignal(),
          body: {
            one: `${a.lat};${a.lon}`,
            many: slice.map((t) => `${t.lat};${t.lon}`),
            mode: motisMode,
            max: Math.ceil(remainingMin * 60 * 1.5),
            maxMatchingDistance: 80,
            withDistance: true,
            arriveBy: false,
          },
        });
        if (error || !data) continue;
        const arr = data as Array<{ duration?: number; distance?: number }>;
        for (let i = 0; i < slice.length; i++) {
          const sec = arr[i]?.duration;
          const dist = arr[i]?.distance;
          if (sec == null || sec > remainingMin * 60) continue;
          // Skip the ratio test for cells < 60m from anchor (one cell
          // radius). At that scale noise dominates and the anchor's
          // own cell has dist≈0, eucl=small → spurious high ratio.
          const eucl = slice[i].euclM;
          if (eucl > 60 && dist != null && dist > eucl * DETOUR_REJECT_RATIO) continue;
          streetDurations[start + i] = sec;
        }
      }

      // Write MOTIS's routed duration per cell. Cells MOTIS couldn't
      // route stay Infinity — accurate to OSM's walkability data.
      // The ONLY Euclidean fallback is the anchor's own cell (the
      // cell containing the station) because stations often don't
      // snap exactly at tight match distance but must still appear
      // reachable. That fallback happens below in the force-write
      // pass.
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (streetDurations[i] == null) continue;
        const totalSec = reachedSec + streetDurations[i]!;
        if (totalSec < durationsSec[t.idx]) durationsSec[t.idx] = totalSec;
      }
    };
    await mapMotis(reachAnchors, rasterAnchor);

    // Guarantee each reachable anchor has a visible footprint around
    // its coord. A single-cell force-write produced degenerate
    // polygons (d3-contour emits a zero-area contour when a single
    // positive cell sits alone in -Inf) — stations at d≈maxMinutes
    // with no remaining walk budget would disappear entirely.
    //
    // Rasterize a small filled disk (~1.5-cell radius) so the marching
    // squares output is round-ish rather than the obvious square a
    // 3×3 box produced. After the downstream buffer smooth, these
    // read as little circles at stations where transit brought you
    // right to the budget limit — a minimum visual indicator, not an
    // inflated walkshed. Anchor-walk rasterization overlays bigger
    // shapes on top for any station with actual remaining budget.
    const anchorDiskRadiusCells = 1.5;
    const anchorR2 = anchorDiskRadiusCells * anchorDiskRadiusCells;
    for (const a of reachAnchors) {
      const cx = ((a.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * nx;
      const cy = ((a.lat - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * ny;
      const reachedSec = a.reachedAtMinutes * 60;
      const xmin = Math.max(0, Math.floor(cx - anchorDiskRadiusCells));
      const xmax = Math.min(nx - 1, Math.ceil(cx + anchorDiskRadiusCells));
      const ymin = Math.max(0, Math.floor(cy - anchorDiskRadiusCells));
      const ymax = Math.min(ny - 1, Math.ceil(cy + anchorDiskRadiusCells));
      for (let y = ymin; y <= ymax; y++) {
        const dy = y + 0.5 - cy;
        for (let x = xmin; x <= xmax; x++) {
          const dx = x + 0.5 - cx;
          if (dx * dx + dy * dy > anchorR2) continue;
          const idx = y * nx + x;
          if (reachedSec < durationsSec[idx]) durationsSec[idx] = reachedSec;
        }
      }
    }
  }

  // Build the field. No water mask — tight street-routing match
  // distances (18m) prevent snapping into open water. Cells near
  // walkable bridges will be reachable, which is accurate.
  //
  // Contour threshold 0 means field > 0 is reachable. For a cell
  // reached at exactly maxMinutes (common at the isochrone edge, e.g.
  // NHSL Penfield at d=30 in a 30-min query), field = 0 = threshold
  // and the cell sits ON the contour boundary, which d3-contour won't
  // emit as inside the polygon. Nudge cells that are within the budget
  // up by 0.5min of field so stations at the edge still render.
  const maxSec = maxMinutes * 60;
  const field = new Float64Array(nx * ny);
  for (let i = 0; i < field.length; i++) {
    const d = durationsSec[i];
    field[i] = d <= maxSec ? maxMinutes - d / 60 + 0.1 : -Infinity;
  }

  // Binary morphological closing on the reachability mask. Fills
  // mid-block holes (cells whose center is more than 18 m from any
  // walkable OSM way — typically interior of large blocks, parking
  // lots) without expanding the outer boundary. Standard image-
  // processing technique: dilate N times, then erode N times. The
  // dilate-erode pair is what makes this safer than naive dilation
  // — naive dilation expanded the polygon outward by N cells in
  // every direction, producing rectangular blobs around isolated
  // rail-anchor seeds; closing contracts the boundary back, leaving
  // shape integrity intact.
  //
  // N=2 fills holes up to ~2 cells wide (~120 m). Larger N starts
  // bridging legitimate barriers (rail yards, river edges) which
  // we don't want — water clip can't catch those because the
  // bridged cells sit on actual land. 2 is the empirical sweet spot.
  const CLOSE_PASSES = 2;
  const reachable = new Uint8Array(nx * ny);
  for (let i = 0; i < field.length; i++) reachable[i] = field[i] > 0 ? 1 : 0;

  for (let pass = 0; pass < CLOSE_PASSES; pass++) {
    const next = new Uint8Array(reachable);
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const idx = y * nx + x;
        if (reachable[idx]) continue;
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (reachable[(y + dy) * nx + (x + dx)]) {
              next[idx] = 1;
              break outer;
            }
          }
        }
      }
    }
    reachable.set(next);
  }
  for (let pass = 0; pass < CLOSE_PASSES; pass++) {
    const next = new Uint8Array(reachable);
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const idx = y * nx + x;
        if (!reachable[idx]) continue;
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (!reachable[(y + dy) * nx + (x + dx)]) {
              next[idx] = 0;
              break outer;
            }
          }
        }
      }
    }
    reachable.set(next);
  }

  // Patch the field with the closed mask. Cells filled by the close
  // pass get a small positive field value (small "minutes remaining"
  // so they sit just inside the contour without distorting the time
  // gradient elsewhere). Cells removed by the close pass go to -Inf.
  for (let i = 0; i < field.length; i++) {
    if (reachable[i] && field[i] <= 0) {
      field[i] = 0.3;
    } else if (!reachable[i] && field[i] > 0) {
      field[i] = -Infinity;
    }
  }

  // Standard raster-to-vector: marching squares at threshold 0, drop
  // noise, project to lat/lon, simplify. Holes get a stricter filter
  // than outer rings — a cell that came back Infinity from MOTIS is
  // usually a snap failure, not a genuine unreachable pocket. Dozens
  // of 1-2 cell pinholes scattered through the main polygon read as
  // striped shading because the basemap shows through at 0.3 opacity.
  const gen = contours().size([nx, ny]).thresholds([0]);
  const polys = gen(field as unknown as number[]);
  if (polys.length === 0 || !polys[0].coordinates.length) return null;

  const fromGrid = (cgx: number, cgy: number): [number, number] => [
    bbox.minLon + (cgx / nx) * (bbox.maxLon - bbox.minLon),
    bbox.minLat + (cgy / ny) * (bbox.maxLat - bbox.minLat),
  ];
  const cellArea = cellM * cellM;
  // Keep single-cell polygons ONLY when they sit near a rail anchor —
  // those are legit tiny walksheds at far-out stations with 1-4 min
  // walking budget (Wayne, Levittown). A single-cell polygon 1-3 km
  // from any anchor is an orphan intermodal cell whose neighbors
  // failed the budget by seconds — it's not a meaningful walkshed,
  // just a rendering artifact. `anchorProximityM` is half the typical
  // far-station walk-disk radius; orphans beyond it get dropped.
  const anchorProximityM = 500;
  const minOuterAreaOrphan = 2 * cellArea; // drop < 2-cell orphans
  const minHoleArea = 20 * cellArea; // drop pinholes below ~270m side
  const anchorPts = reachAnchors ?? [];

  function isNearAnchor(lon: number, lat: number): boolean {
    const mLat = M_PER_DEG_LAT;
    const mLon = metersPerDegLon(lat);
    for (const a of anchorPts) {
      const dLatM = (lat - a.lat) * mLat;
      const dLonM = (lon - a.lon) * mLon;
      if (dLatM * dLatM + dLonM * dLonM <= anchorProximityM * anchorProximityM) return true;
    }
    return false;
  }

  const kept: Position[][][] = [];
  for (const poly of polys[0].coordinates) {
    const [outer, ...holes] = poly;
    if (!outer) continue;
    const areaM2 = Math.abs(ringAreaCells(outer)) * cellArea;
    if (areaM2 < minOuterAreaOrphan) {
      // Tiny polygon: keep only if centroid is near a rail anchor.
      let cx = 0, cy = 0;
      for (const [x, y] of outer) { cx += x; cy += y; }
      cx /= outer.length; cy /= outer.length;
      const [lon, lat] = fromGrid(cx, cy);
      if (!isNearAnchor(lon, lat)) continue;
    }
    const rings: Position[][] = [outer.map(([x, y]) => fromGrid(x, y))];
    for (const h of holes) {
      if (Math.abs(ringAreaCells(h)) * cellArea < minHoleArea) continue;
      rings.push(h.map(([x, y]) => fromGrid(x, y)));
    }
    kept.push(rings);
  }
  if (kept.length === 0) return null;

  // Standard raster-to-vector cleanup:
  //   1. truncate to 5-decimal precision (~1m) — d3-contour emits
  //      floating-point noise at cell-grid boundaries; snapping
  //      defeats near-coincident vertices that later cause
  //      self-intersections.
  //   2. rewind — d3-contour outputs grid-space rings (y-down); after
  //      converting to lat/lon (y-up) the winding flips, producing
  //      CW outer / CCW hole rings. GeoJSON + MapLibre need the
  //      opposite (right-hand rule) or fills render inside-out.
  //   3. cleanCoords — remove duplicate consecutive vertices.
  //   4. buffer(0) + union-fold (below) — canonicalize geometry via
  //      martinez polygon-clipping: splits any remaining
  //      self-intersecting rings, merges accidentally-overlapping
  //      sub-polygons, produces a single spec-clean MultiPolygon
  //      that MapLibre renders without overlap-strip / touching-ring
  //      artifacts.
  const feat: Feature<MultiPolygon> = {
    type: "Feature",
    properties: { minutes: maxMinutes, method: "graph" },
    geometry: { type: "MultiPolygon", coordinates: kept },
  };
  let clean: Feature<Polygon | MultiPolygon> = feat;
  try { clean = truncate(clean, { precision: 5, mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep feat */ }
  try { clean = rewind(clean, { reverse: false, mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep clean */ }
  try { clean = cleanCoords(clean, { mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep clean */ }
  try {
    // Small positive buffer softens the marching-squares cell-boundary
    // staircase into a rounded outline. Also pulls in the buffer(0)
    // canonicalization side-effect (splits self-intersecting rings,
    // merges overlapping sub-polygons via jsts' polygon-clipping).
    // 10 m is invisible relative to polygon area (~5 km radius) but
    // takes the edges from pixelated to smooth. `steps: 4` keeps the
    // vertex count down — at 10 m radius even 4 arc steps render as
    // a soft round corner at display zoom.
    const buffered = buffer(clean, 10, { units: "meters", steps: 4 });
    if (buffered && buffered.geometry) clean = buffered as Feature<Polygon | MultiPolygon>;
  } catch { /* keep clean */ }

  const sourceCoords: Position[][][] = clean.geometry.type === "MultiPolygon"
    ? clean.geometry.coordinates as Position[][][]
    : [clean.geometry.coordinates as Position[][]];
  if (sourceCoords.length === 0) return null;

  // Fold union: start with first polygon, union each subsequent.
  // Polygons that fail union (usually tiny degenerate ones) are kept
  // as separate pieces in the final MultiPolygon so far-out rail
  // stations with 1-cell walksheds (Manayunk, Germantown at 30min
  // City Hall) still appear.
  let merged: Feature<Polygon | MultiPolygon> | null = null;
  const orphans: Position[][][] = [];
  try {
    merged = tpoly(sourceCoords[0]) as Feature<Polygon | MultiPolygon>;
    for (let i = 1; i < sourceCoords.length; i++) {
      try {
        const next = tpoly(sourceCoords[i]);
        const u = union(featureCollection([merged, next]));
        if (u) merged = u as Feature<Polygon | MultiPolygon>;
        else orphans.push(sourceCoords[i]);
      } catch {
        orphans.push(sourceCoords[i]);
      }
    }
  } catch {
    merged = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: sourceCoords } };
  }
  if (!merged) return null;
  // Merge orphans into the final MultiPolygon.
  let finalCoords: Position[][][];
  if (merged.geometry.type === "Polygon") {
    finalCoords = [merged.geometry.coordinates as Position[][], ...orphans];
  } else {
    finalCoords = [...(merged.geometry.coordinates as Position[][][]), ...orphans];
  }
  const out: Feature<MultiPolygon> = {
    type: "Feature",
    properties: { minutes: maxMinutes, method: "graph" },
    geometry: { type: "MultiPolygon", coordinates: finalCoords },
  };
  return { type: "FeatureCollection", features: [out] };
}

// Signed shoelace area of a ring in cell-grid coordinates. Sign reflects
// winding direction — we only use |area|.
function ringAreaCells(ring: ReadonlyArray<ArrayLike<number>>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}
