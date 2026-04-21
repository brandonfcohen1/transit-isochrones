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
import KDBush from "kdbush";
import { contours } from "d3-contour";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

const WALKING_KMH = 4.8;
const WALKING_M_PER_MIN = (WALKING_KMH * 1000) / 60; // 80 m/min

// Grid cell size in meters. Smaller = smoother polygon and captures
// far-reaching transit stops with small remaining-walk budget (e.g. a
// Regional Rail stop reached at 28/30 min has only a ~160m walking
// radius — at 150m cells that reach collapses to a single pixel).
// 60m gives clean rendering for both city-center walking circles and the
// small islands of reachability around distant rail stops.
const CELL_M = 60;

// Equirectangular projection is fine at city scale.
const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

// `m` is the coarsest mode present at this stop, ranked
// rail > subway > tram > bus > other. Lets the client render rail-only
// dots in a distinct color so it's obvious when transit is being used.
export type StopMode = "rail" | "subway" | "tram" | "bus" | "other";
export type SlimStop = { id: string; lat: number; lon: number; d: number; m: StopMode };

export function buildIsochrone(
  origin: { lat: number; lon: number },
  stops: SlimStop[],
  maxMinutes: number,
): Feature<Polygon | MultiPolygon> | null {
  const mPerLon = metersPerDegLon(origin.lat);
  const mPerLat = M_PER_DEG_LAT;

  // Each stop's reachable radius (meters we can walk from it in remaining budget).
  // Origin contributes a full maxMinutes walking radius.
  const originRadiusM = maxMinutes * WALKING_M_PER_MIN;

  // bbox in lat/lon that covers the origin walking circle plus every stop's
  // own walking remainder. Stops with d >= maxMinutes contribute nothing.
  let minLat = origin.lat - originRadiusM / mPerLat;
  let maxLat = origin.lat + originRadiusM / mPerLat;
  let minLon = origin.lon - originRadiusM / mPerLon;
  let maxLon = origin.lon + originRadiusM / mPerLon;
  for (const s of stops) {
    const remaining = maxMinutes - s.d;
    if (remaining <= 0) continue;
    const rM = remaining * WALKING_M_PER_MIN;
    const dLat = rM / mPerLat;
    const dLon = rM / mPerLon;
    if (s.lat - dLat < minLat) minLat = s.lat - dLat;
    if (s.lat + dLat > maxLat) maxLat = s.lat + dLat;
    if (s.lon - dLon < minLon) minLon = s.lon - dLon;
    if (s.lon + dLon > maxLon) maxLon = s.lon + dLon;
  }

  const widthM = (maxLon - minLon) * mPerLon;
  const heightM = (maxLat - minLat) * mPerLat;
  const nx = Math.max(16, Math.round(widthM / CELL_M));
  const ny = Math.max(16, Math.round(heightM / CELL_M));

  // Project lat/lon to grid (cell coords, origin at bottom-left).
  const toGridX = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * nx;
  const toGridY = (lat: number) => ((lat - minLat) / (maxLat - minLat)) * ny;

  // All stops (including synthetic origin) go into a KD-tree in cell space.
  const total = stops.length + 1;
  const idx = new KDBush(total);
  const gx = new Float64Array(total);
  const gy = new Float64Array(total);
  const durs = new Float64Array(total);

  for (let i = 0; i < stops.length; i++) {
    gx[i] = toGridX(stops[i].lon);
    gy[i] = toGridY(stops[i].lat);
    durs[i] = stops[i].d;
    idx.add(gx[i], gy[i]);
  }
  // Origin as synthetic stop with duration 0 so the walking circle exists
  // even if no transit stop is in range.
  gx[stops.length] = toGridX(origin.lon);
  gy[stops.length] = toGridY(origin.lat);
  durs[stops.length] = 0;
  idx.add(gx[stops.length], gy[stops.length]);
  idx.finish();

  // Cells farther than maxMinutes walk (in cell-units) from a stop never
  // contribute — this is the per-stop cap used by `idx.within`.
  const searchCellR = (maxMinutes * WALKING_M_PER_MIN) / CELL_M + 1;

  // field[y*nx + x] = maxMinutes - min(duration + walkMinutes).
  // Positive = reachable with that many minutes of slack.
  // -Infinity = no stop in range = unreachable.
  const field = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const near = idx.within(cx, cy, searchCellR);
      if (near.length === 0) {
        field[y * nx + x] = -Infinity;
        continue;
      }
      let bestCost = Infinity;
      for (let k = 0; k < near.length; k++) {
        const si = near[k];
        const dxC = gx[si] - cx;
        const dyC = gy[si] - cy;
        const distM = Math.sqrt(dxC * dxC + dyC * dyC) * CELL_M;
        const total = durs[si] + distM / WALKING_M_PER_MIN;
        if (total < bestCost) bestCost = total;
      }
      field[y * nx + x] = maxMinutes - bestCost;
    }
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
