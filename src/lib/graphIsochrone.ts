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
import { buffer, cleanCoords, featureCollection, polygon as tpoly, rewind, truncate, union } from "@turf/turf";
import type { Mode, OneToManyIntermodalResponse } from "@motis-project/motis-client";
import { oneToManyIntermodalPost, oneToManyPost } from "@/lib/motis";
import { mapMotis } from "@/lib/motisLimiter";

export type StreetMode = "walk" | "bike";

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
// 3× and graph time ~linearly. The downstream polygon simplify runs
// at ~33m tolerance so the displayed outline looks about the same
// regardless of source cell size.
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
      if (error) return;
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
    // Hybrid street-routed + Euclidean-fallback anchor walks.
    //
    // For each late-budget anchor (reached > half the total budget, so
    // we skip close-in city-center stations whose reach is already
    // covered by intermodal), call MOTIS one-to-many WALK to every
    // cell inside the Euclidean walk budget. MOTIS returns the true
    // street-graph duration for cells it can snap and route to within
    // the budget.
    //
    // If MOTIS returns at least MIN_STREET_CELLS densely connected
    // cells, use its durations (street-accurate shape). If it returns
    // too few (snap failures dominate), fall back to filling the disk
    // with Euclidean * 1.3 detour so the walkshed at least renders as
    // a clean circle rather than disappearing entirely.
    //
    // The late-budget cutoff keeps big early-budget disks (2-3km
    // radius) from ever running — those would cross rivers via the
    // ferry/bridge snap that the 80m match distance permits. Suburban
    // stations' tiny disks (< 500m) are safely away from water.
    const walkSpeedMPerMin = (5 * 1000) / 60; // 5 km/h ceiling
    const DETOUR = 1.3;
    const effectiveMPerMin = walkSpeedMPerMin / DETOUR;
    const mLat = M_PER_DEG_LAT;
    const mLon = metersPerDegLon(origin.lat);
    const anchorBudgetCutoff = maxMinutes / 2;
    // A disk with radius r cells has ~π·r² cells inside. At r≈2.8
    // (2-min budget on 60m cells) that's ~24 cells. We want at least
    // a quarter of them for a "dense enough" classification — roughly
    // a 3-cell contiguous blob. Below that, fall back to Euclidean.
    const MIN_STREET_CELLS = 6;

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

      // Collect candidate cells (inside the Euclidean disk) and their
      // target coords for MOTIS. Keep each cell's Euclidean walkSec as
      // the fallback if MOTIS doesn't return a time for it. Cells that
      // land in water are excluded — otherwise a disk around a
      type Target = { idx: number; coord: string; euclideanSec: number };
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
          const euclideanSec = Math.sqrt(distM2) / effectiveMPerMin * 60;
          targets.push({
            idx: y * nx + x,
            coord: `${cellLat.toFixed(5)};${cellLon.toFixed(5)}`,
            euclideanSec,
          });
        }
      }
      if (targets.length === 0) return;

      // MOTIS street-routing pass. 40m match lets cells snap to real
      // suburban streets (which are often 20-35m from a grid cell
      // center) so the walkshed follows the road grid instead of
      // circling out as an Euclidean disk. Euclidean fallback is
      // used ONLY for the anchor's own cell — stations whose GTFS
      // coord doesn't snap still need to show as reachable.
      const streetDurations = new Array<number | undefined>(targets.length);
      for (let start = 0; start < targets.length; start += MAX_MANY_PER_REQUEST) {
        const slice = targets.slice(start, start + MAX_MANY_PER_REQUEST);
        const { data, error } = await oneToManyPost({
          body: {
            one: `${a.lat};${a.lon}`,
            many: slice.map((t) => t.coord),
            mode: "WALK",
            max: Math.ceil(remainingMin * 60 * 1.5),
            maxMatchingDistance: 40,
            arriveBy: false,
          },
        });
        if (error || !data) continue;
        const arr = data as Array<{ duration?: number }>;
        for (let i = 0; i < slice.length; i++) {
          const sec = arr[i]?.duration;
          if (sec != null && sec <= remainingMin * 60) streetDurations[start + i] = sec;
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

    // Guarantee each reachable anchor's OWN cell has its reachedAt
    // duration — regardless of whether the late-budget cutoff skipped
    // its disk rasterization, or whether MOTIS failed to snap its
    // coord (OSM water polygons sometimes overhang stations like
    // 30th St). Without this, close-in rail stations whose cells
    // weren't written by intermodal end up at Infinity and the
    // station disappears from the polygon.
    for (const a of reachAnchors) {
      const cx = Math.floor(((a.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * nx);
      const cy = Math.floor(((a.lat - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * ny);
      if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue;
      const idx = cy * nx + cx;
      const reachedSec = a.reachedAtMinutes * 60;
      if (reachedSec < durationsSec[idx]) durationsSec[idx] = reachedSec;
    }
  }

  // Build the field. No water mask — tight street-routing match
  // distances (18m) prevent snapping into open water. Cells near
  // walkable bridges will be reachable, which is accurate.
  const maxSec = maxMinutes * 60;
  const field = new Float64Array(nx * ny);
  for (let i = 0; i < field.length; i++) {
    const d = durationsSec[i];
    field[i] = d <= maxSec ? maxMinutes - d / 60 : -Infinity;
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
  // No outer-ring filter — keep every polygon d3-contour produces,
  // including tiny single-cell islands at far-out rail stations that
  // only have 1-2 min of walking budget (Manayunk/Germantown from
  // downtown, Eddystone at 60-min). Union-fold downstream cleans any
  // noise; tests expect every reachable rail station to be visible.
  const minOuterArea = 0;
  const minHoleArea = 20 * cellArea; // drop pinholes below ~270m side

  const kept: Position[][][] = [];
  for (const poly of polys[0].coordinates) {
    const [outer, ...holes] = poly;
    if (!outer || Math.abs(ringAreaCells(outer)) * cellArea < minOuterArea) continue;
    const rings: Position[][] = [outer.map(([x, y]) => fromGrid(x, y))];
    for (const h of holes) {
      if (Math.abs(ringAreaCells(h)) * cellArea < minHoleArea) continue;
      rings.push(h.map(([x, y]) => fromGrid(x, y)));
    }
    kept.push(rings);
  }
  if (kept.length === 0) return null;

  // Standard raster-to-vector cleanup:
  //   1. rewind — d3-contour outputs grid-space rings (y-down); after
  //      converting to lat/lon (y-up) the winding flips, producing
  //      CW outer / CCW hole rings. GeoJSON + MapLibre need the
  //      opposite (right-hand rule) or fills render inside-out.
  //   2. cleanCoords — remove duplicate consecutive vertices.
  //   3. unkinkPolygon — d3-contour occasionally produces
  //      self-intersecting rings at cell-boundary touches (ring
  //      crosses itself). MapLibre's fill-rule then stacks the fill
  //      twice at the overlap, producing darker strips that look
  //      like separate polygon overlays. unkinkPolygon splits each
  //      self-intersecting polygon into valid, non-self-intersecting
  //      sub-polygons.
  const feat: Feature<MultiPolygon> = {
    type: "Feature",
    properties: { minutes: maxMinutes, method: "graph" },
    geometry: { type: "MultiPolygon", coordinates: kept },
  };
  let clean: Feature<Polygon | MultiPolygon> = feat;
  // truncate to 5-decimal precision (~1m) first — d3-contour emits
  // floating-point noise at cell-grid boundaries that causes near-
  // coincident vertices, which in turn cause self-intersections
  // after subsequent passes. Snapping to 1m defeats this.
  try { clean = truncate(clean, { precision: 5, mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep feat */ }
  try { clean = rewind(clean, { reverse: false, mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep clean */ }
  try { clean = cleanCoords(clean, { mutate: true }) as Feature<Polygon | MultiPolygon>; }
  catch { /* keep clean */ }

  // buffer(0) + union-fold canonicalize the geometry through
  // martinez polygon-clipping: splits self-intersecting rings, merges
  // any accidentally-overlapping sub-polygons, and produces a single
  // spec-clean MultiPolygon. This is what reliably renders in
  // MapLibre without the overlap-strip / touching-ring artifacts.
  try {
    const buffered = buffer(clean, 0, { units: "meters" });
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
