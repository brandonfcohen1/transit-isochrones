// Grid + marching-squares isochrone builder. Same family Valhalla / OTP2 / r5 use.
//
// Algorithm:
//   1. Rasterize a lat/lon grid over the bbox of (origin-walking-circle ∪
//      every reachable-stop's remaining-walking-circle). Far-reaching transit
//      stops need the grid to follow them, not just the origin.
//   2. For each cell, field = maxMinutes - min_over_stops(duration + walk(cell, stop)).
//      Positive field = reachable with that many minutes to spare.
//   3. Contour the field at threshold 0 with d3-contour (marching-squares).
//      d3-contour polygons enclose values ABOVE the threshold — so positive
//      field, i.e. reachable area.
import { contours } from "d3-contour";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

// Street speeds in km/h. Bike default matches MOTIS's default cycling speed
// (~15 km/h); walk matches a typical brisk pace.
const WALK_KMH = 4.8;
const BIKE_KMH = 15;

// Detour factor: how much longer a real street route is than crow-flies.
// Philly's dense grid gives ~1.2–1.4 empirically. We scale the Euclidean
// reach-radius around each stop by 1/detourFactor so the contour roughly
// matches what you could actually walk/bike on streets. The "safe streets"
// mode raises it to account for detours to lit streets / bike lanes /
// crossings — i.e. the tradeoff the rider is willing to make.
const DETOUR_WALK = 1.3;
const DETOUR_WALK_SAFE = 1.55;
const DETOUR_BIKE = 1.25;
const DETOUR_BIKE_SAFE = 1.5;

export type StreetMode = "walk" | "bike";

export type IsoOpts = {
  mode?: StreetMode;
  safe?: boolean;
  /** Override street speed in km/h (defaults to walk/bike norm). */
  speedKmh?: number;
  /** Override detour factor (defaults per mode+safe). */
  detourFactor?: number;
  /**
   * When true, don't synthesize a zero-duration stop at the origin.
   * Use this with an externally-provided street-routed grid — otherwise
   * the Euclidean origin circle will always beat the (longer, honest)
   * routed distances to each cell and drown out the street shape.
   */
  skipOriginStop?: boolean;
};

function speedForMode(m: StreetMode): number {
  return m === "bike" ? BIKE_KMH : WALK_KMH;
}

function detourForMode(m: StreetMode, safe: boolean): number {
  if (m === "bike") return safe ? DETOUR_BIKE_SAFE : DETOUR_BIKE;
  return safe ? DETOUR_WALK_SAFE : DETOUR_WALK;
}

// Grid cell size in meters. Smaller = smoother polygon and captures
// far-reaching transit stops with small remaining-budget (e.g. a
// Regional Rail stop reached at 28/30 min has only a ~160m walking
// radius — at 150m cells that reach collapses to a single pixel).
// 60m gives clean rendering for both city-center circles and the small
// islands of reachability around distant rail stops.
const CELL_M_WALK = 60;
// Bike reach is ~3x larger, so cells can be larger without losing fidelity.
const CELL_M_BIKE = 120;

// Equirectangular projection is fine at city scale.
const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

// `m` is the coarsest mode present at this stop, ranked
// rail > subway > tram > bus > other. Lets the client render rail-only
// dots in a distinct color so it's obvious when transit is being used.
export type StopMode = "rail" | "subway" | "trolley" | "bus" | "other";
export type SlimStop = { id: string; lat: number; lon: number; d: number; m: StopMode; n?: string };

export function buildIsochrone(
  origin: { lat: number; lon: number },
  stops: SlimStop[],
  maxMinutes: number,
  opts: IsoOpts = {},
): Feature<Polygon | MultiPolygon> | null {
  const mode = opts.mode ?? "walk";
  const safe = opts.safe ?? false;
  const speedKmh = opts.speedKmh ?? speedForMode(mode);
  const detour = opts.detourFactor ?? detourForMode(mode, safe);
  // Effective street-distance per minute on the contour — crow-flies reach
  // is (speedKmh/60 km/min) / detour. This is the knob that makes bike
  // isochrones reach farther and "safe streets" reach shorter.
  const streetMPerMin = ((speedKmh * 1000) / 60) / detour;
  const cellM = mode === "bike" ? CELL_M_BIKE : CELL_M_WALK;

  const mPerLon = metersPerDegLon(origin.lat);
  const mPerLat = M_PER_DEG_LAT;

  // Each stop's reachable radius (meters we can walk from it in remaining budget).
  // Origin contributes a full maxMinutes radius.
  const originRadiusM = maxMinutes * streetMPerMin;

  // bbox in lat/lon that covers the origin walking circle plus every stop's
  // own walking remainder. Stops with d >= maxMinutes contribute nothing.
  let minLat = origin.lat - originRadiusM / mPerLat;
  let maxLat = origin.lat + originRadiusM / mPerLat;
  let minLon = origin.lon - originRadiusM / mPerLon;
  let maxLon = origin.lon + originRadiusM / mPerLon;
  for (const s of stops) {
    const remaining = maxMinutes - s.d;
    if (remaining <= 0) continue;
    const rM = remaining * streetMPerMin;
    const dLat = rM / mPerLat;
    const dLon = rM / mPerLon;
    if (s.lat - dLat < minLat) minLat = s.lat - dLat;
    if (s.lat + dLat > maxLat) maxLat = s.lat + dLat;
    if (s.lon - dLon < minLon) minLon = s.lon - dLon;
    if (s.lon + dLon > maxLon) maxLon = s.lon + dLon;
  }

  const widthM = (maxLon - minLon) * mPerLon;
  const heightM = (maxLat - minLat) * mPerLat;
  const nx = Math.max(16, Math.round(widthM / cellM));
  const ny = Math.max(16, Math.round(heightM / cellM));

  // Project lat/lon to grid (cell coords, origin at bottom-left).
  const toGridX = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * nx;
  const toGridY = (lat: number) => ((lat - minLat) / (maxLat - minLat)) * ny;

  // Stops (optionally including a synthetic origin) in grid coords. In
  // precise-streets mode the caller has already seeded routed grid cells,
  // so we skip the zero-cost origin — otherwise straight-line distances
  // to each cell would beat the routed durations.
  const includeOrigin = !opts.skipOriginStop;
  const total = stops.length + (includeOrigin ? 1 : 0);
  const gx = new Float64Array(total);
  const gy = new Float64Array(total);
  const durs = new Float64Array(total);

  for (let i = 0; i < stops.length; i++) {
    gx[i] = toGridX(stops[i].lon);
    gy[i] = toGridY(stops[i].lat);
    durs[i] = stops[i].d;
  }
  if (includeOrigin) {
    gx[stops.length] = toGridX(origin.lon);
    gy[stops.length] = toGridY(origin.lat);
    durs[stops.length] = 0;
  }

  // field[i] tracks min cost in minutes (Infinity = unreachable).
  // Each stop rasterizes its reachable disk, keeping the minimum at each
  // cell. Inverting the loop (stops outer, cells inner) is the big win:
  //   - no per-cell allocation (kdbush.within allocates a new Array
  //     per cell — 6400 arrays × 50-200 elements each hits the GC hard)
  //   - disk bounds let us skip whole rows outside the stop's reach
  //   - squared-distance early-exit skips the sqrt unless the stop
  //     actually improves the cell, which matters in overlapping-disk
  //     regions where most cells are already at a good cost.
  // Field values are converted to (maxMinutes - cost) after the sweep.
  const minCost = new Float64Array(nx * ny).fill(Infinity);
  const minPerCell = cellM / streetMPerMin; // minutes per unit cell-distance

  for (let i = 0; i < total; i++) {
    const sd = durs[i];
    const remaining = maxMinutes - sd;
    if (remaining <= 0) continue;
    const radiusCells = remaining / minPerCell;
    const r2 = radiusCells * radiusCells;
    const sx = gx[i];
    const sy = gy[i];

    const ymin = Math.max(0, Math.floor(sy - radiusCells));
    const ymax = Math.min(ny - 1, Math.ceil(sy + radiusCells));
    const xmin = Math.max(0, Math.floor(sx - radiusCells));
    const xmax = Math.min(nx - 1, Math.ceil(sx + radiusCells));

    for (let y = ymin; y <= ymax; y++) {
      const dy = y + 0.5 - sy;
      const dyS = dy * dy;
      if (dyS > r2) continue;
      // dx² budget before we're past the disk edge.
      const dxBudget2 = r2 - dyS;
      const dxBudget = Math.sqrt(dxBudget2);
      const xs = Math.max(xmin, Math.ceil(sx - dxBudget - 0.5));
      const xe = Math.min(xmax, Math.floor(sx + dxBudget - 0.5));
      const rowOff = y * nx;
      for (let x = xs; x <= xe; x++) {
        const dx = x + 0.5 - sx;
        const dS = dx * dx + dyS;
        // Current best cost → max distance this stop would need to beat
        // it. Compare squared to skip the sqrt in no-improvement cases.
        const cur = minCost[rowOff + x];
        const budget = (cur - sd) / minPerCell;
        if (budget <= 0) continue;
        if (dS >= budget * budget) continue;
        const newCost = sd + Math.sqrt(dS) * minPerCell;
        if (newCost < cur) minCost[rowOff + x] = newCost;
      }
    }
  }

  // Convert min-cost → field. d3-contour encloses cells ABOVE threshold 0.
  const field = new Float64Array(nx * ny);
  for (let i = 0; i < field.length; i++) {
    const c = minCost[i];
    field[i] = c === Infinity ? -Infinity : maxMinutes - c;
  }

  // Contour at 0 — polygon encloses cells where field > 0, i.e. reachable.
  const gen = contours().size([nx, ny]).thresholds([0]);
  const polys = gen(Array.from(field));
  if (polys.length === 0) return null;
  const contour = polys[0];
  if (!contour.coordinates.length) return null;

  const fromGrid = (cgx: number, cgy: number): [number, number] => [
    minLon + (cgx / nx) * (maxLon - minLon),
    minLat + (cgy / ny) * (maxLat - minLat),
  ];

  const coords: Position[][][] = contour.coordinates.map((poly) =>
    poly.map((ring) => ring.map(([cgx, cgy]) => fromGrid(cgx, cgy))),
  );

  return {
    type: "Feature",
    properties: { minutes: maxMinutes },
    geometry: { type: "MultiPolygon", coordinates: coords },
  };
}
