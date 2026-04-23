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
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type { Mode } from "@motis-project/motis-client";

export type StreetMode = "walk" | "bike";

const MAX_MANY_PER_REQUEST = 1024; // matches timetable.onetomany_max_many
// MOTIS is C++ with an internal thread pool; localhost HTTP is cheap, so
// push concurrency high. Beyond ~16 we don't see much further speedup.
const CONCURRENCY = 16;

const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

// Cell size in meters. Flat per-mode: the bbox is already bounded by
// the reachable-stops envelope (see stopsEnvelope in the route handler),
// so cell count doesn't blow up quadratically with budget like the
// worst-case bbox would have. 60m walk / 90m bike matches MOTIS's
// ~25m street-snap tolerance closely enough that going finer mostly
// adds noise from cells that all snap to the same street edge.
function cellSizeM(mode: StreetMode): number {
  return mode === "bike" ? 90 : 60;
}

// Worst-case transit reach for bbox sizing when the caller doesn't
// supply one. Regional Rail tops out around 55 km/h in this system.
// Cells outside the real reach come back null and contribute -Inf to
// the field, which is fine.
const TRANSIT_KMH_CEILING = 55;

type IntermodalResponse = {
  street_durations?: Array<{ duration?: number }>;
  transit_durations?: Array<Array<{ duration: number; transfers: number }>>;
};

export async function graphIsochrone(args: {
  origin: { lat: number; lon: number };
  maxMinutes: number;
  mode: StreetMode;
  // Pass one time for a single-instant isochrone, or multiple times to
  // get a "best-case over the day" polygon — we take the min duration
  // per cell across all provided times before contouring.
  times: string[];
  motisUrl: string;
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  // Extra reach anchors — typically reachable transit stops (e.g.
  // Regional Rail stations) where `one-to-many-intermodal` misses the
  // connection but `one-to-all` correctly reports the arrival time.
  // Each anchor gets a walking-reach disk rasterized into the field
  // at radius (maxMinutes - reachedAtMinutes) * walk-speed.
  reachAnchors?: Array<{ lat: number; lon: number; reachedAtMinutes: number }>;
}): Promise<Feature<Polygon | MultiPolygon> | null> {
  const { origin, maxMinutes, mode, times, motisUrl, reachAnchors } = args;
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

  const cellM = cellSizeM(mode);
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
  // each time internally fans out to CONCURRENCY parallel batches.
  for (const time of times) {
    await parallelWithLimit(batchIdx, CONCURRENCY, async (bi) => {
      const start = bi * MAX_MANY_PER_REQUEST;
      const end = Math.min(targets.length, start + MAX_MANY_PER_REQUEST);
      const slice = targets.slice(start, end);
      const body = {
        one: `${origin.lat},${origin.lon}`,
        many: slice,
        time,
        maxTravelTime: maxMinutes,
        arriveBy: false,
        transitModes: ["TRANSIT"],
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
      };
      const res = await fetch(`${motisUrl}/api/experimental/one-to-many-intermodal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
      const j = (await res.json()) as IntermodalResponse;
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
    const walkSpeedMPerMin = (5 * 1000) / 60; // 5 km/h ceiling
    const fromGridLatLon = (x: number, y: number): [number, number] => [
      bbox.minLat + ((y + 0.5) / ny) * (bbox.maxLat - bbox.minLat),
      bbox.minLon + ((x + 0.5) / nx) * (bbox.maxLon - bbox.minLon),
    ];
    const fanAnchor = async (a: NonNullable<typeof reachAnchors>[number]): Promise<void> => {
      const remainingMin = maxMinutes - a.reachedAtMinutes;
      if (remainingMin <= 0) return;
      // Collect grid cells within the anchor's walking budget (at a
      // generous speed so real routed paths, which are never faster
      // than straight-line, have room to match).
      const radiusCells = (remainingMin * walkSpeedMPerMin) / cellM;
      if (radiusCells <= 0) return;
      const ax = ((a.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * nx;
      const ay = ((a.lat - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * ny;
      const r2 = radiusCells * radiusCells;
      const ymin = Math.max(0, Math.floor(ay - radiusCells));
      const ymax = Math.min(ny - 1, Math.ceil(ay + radiusCells));
      const xmin = Math.max(0, Math.floor(ax - radiusCells));
      const xmax = Math.min(nx - 1, Math.ceil(ax + radiusCells));
      const targets: { idx: number; coord: string }[] = [];
      for (let y = ymin; y <= ymax; y++) {
        const dy = y + 0.5 - ay;
        const dyS = dy * dy;
        if (dyS > r2) continue;
        for (let x = xmin; x <= xmax; x++) {
          const dx = x + 0.5 - ax;
          if (dx * dx + dyS > r2) continue;
          const [lat, lon] = fromGridLatLon(x, y);
          // /api/v1/one-to-many uses semicolon-separated lat;lon.
          targets.push({ idx: y * nx + x, coord: `${lat.toFixed(5)};${lon.toFixed(5)}` });
        }
      }
      if (targets.length === 0) return;
      const reachedSec = a.reachedAtMinutes * 60;
      for (let start = 0; start < targets.length; start += MAX_MANY_PER_REQUEST) {
        const slice = targets.slice(start, start + MAX_MANY_PER_REQUEST);
        const body = {
          one: `${a.lat};${a.lon}`,
          many: slice.map((t) => t.coord),
          mode: "WALK",
          max: Math.ceil(remainingMin * 60),
          // Cells can land mid-block; allow the same match slack that
          // streetGridStops uses so they still snap to a nearby street.
          maxMatchingDistance: 80,
          arriveBy: false,
        };
        const res = await fetch(`${motisUrl}/api/v1/one-to-many`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) continue;
        const arr = (await res.json()) as Array<{ duration?: number }>;
        for (let i = 0; i < slice.length; i++) {
          const walkSec = arr[i]?.duration;
          if (walkSec == null) continue;
          const totalSec = reachedSec + walkSec;
          if (totalSec < durationsSec[slice[i].idx]) {
            durationsSec[slice[i].idx] = totalSec;
          }
        }
      }
    };
    await parallelWithLimit(reachAnchors, 8, fanAnchor);
  }

  // Build the field. Positive = reachable with that many minutes of slack.
  // -Infinity = unreachable. d3-contour encloses cells ABOVE threshold 0.
  const maxSec = maxMinutes * 60;
  const field = new Float64Array(nx * ny);
  for (let i = 0; i < field.length; i++) {
    const d = durationsSec[i];
    field[i] = d <= maxSec ? maxMinutes - d / 60 : -Infinity;
  }

  // (Previously: 3x3 dilate+erode to fill single-cell pinholes. Removed —
  // it also bridged narrow unreachable gaps, most visibly fusing Philly's
  // walk-reach with Camden's PATCO transit-reach across the Delaware. The
  // hole-area filter below handles the real interior-artifact case.)

  const gen = contours().size([nx, ny]).thresholds([0]);
  const polys = gen(Array.from(field));
  if (polys.length === 0) return null;
  const contour = polys[0];
  if (!contour.coordinates.length) return null;

  const fromGrid = (cgx: number, cgy: number): [number, number] => [
    bbox.minLon + (cgx / nx) * (bbox.maxLon - bbox.minLon),
    bbox.minLat + (cgy / ny) * (bbox.maxLat - bbox.minLat),
  ];

  // Ring area filter. Tiny polygons and tiny holes are almost always
  // single-cell artifacts, not real features (real reachability pockets
  // are block-scale or bigger). Threshold = (3*cellM)² — a ring must
  // span at least ~9 cells of area to survive.
  const minRingM2 = 9 * cellM * cellM;
  const kept: Position[][][] = [];
  for (const poly of contour.coordinates) {
    // Ring 0 is the outer shell; ring 1+ are holes.
    const outer = poly[0];
    if (!outer) continue;
    const outerArea = Math.abs(ringAreaCells(outer)) * cellM * cellM;
    if (outerArea < minRingM2) continue;
    const rings: Position[][] = [outer.map(([cgx, cgy]) => fromGrid(cgx, cgy))];
    for (let i = 1; i < poly.length; i++) {
      const holeArea = Math.abs(ringAreaCells(poly[i])) * cellM * cellM;
      if (holeArea < minRingM2) continue;
      rings.push(poly[i].map(([cgx, cgy]) => fromGrid(cgx, cgy)));
    }
    kept.push(rings);
  }
  if (kept.length === 0) return null;

  return {
    type: "Feature",
    properties: { minutes: maxMinutes, method: "graph" },
    geometry: { type: "MultiPolygon", coordinates: kept },
  };
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

async function parallelWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
