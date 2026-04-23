// Street-routed reach via MOTIS one-to-many.
//
// Given an origin and a max-minute budget, build a grid of target cells
// around the origin, ask MOTIS for the walk/bike duration to each cell on
// the real OSM street network, and return the reachable ones as synthetic
// "stops" (duration in minutes, mode "other") that `buildIsochrone` can
// consume alongside transit stops.
//
// The point is to replace the Euclidean-circle-with-detour-factor
// approximation around the origin with an actually street-routed area —
// while leaving transit-extended regions on the (cheap, good-enough)
// Euclidean path. Transit stops already get us most of the way there;
// this just makes the central walking/biking region honest.
import type { SlimStop } from "./isochrone";
import { oneToManyPost } from "@/lib/motis";
import { mapMotis } from "@/lib/motisLimiter";

// Matches the raised `onetomany_max_many: 1024` in data/config.yml. Cap
// exists mostly to keep per-request timeout risk bounded — walk-30min
// and bike-30min grids both fit comfortably in one call at this size.
const MAX_MANY_PER_REQUEST = 1024;

// Grid spacing in meters. Coarser than the contouring cell so the grid
// fits in a reasonable number of MOTIS calls; the contouring step then
// interpolates between grid nodes via the KD-tree nearest-stop field.
const GRID_SPACING_M = 150;

const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

type MotisStreetMode = "WALK" | "BIKE";

// Typical speed for sizing the grid bbox. We intentionally overshoot so
// that cells at the edge that MOTIS marks unreachable stay in the grid
// and contribute nothing to the polygon, rather than clipping the
// reachable envelope by a too-tight bbox.
const SPEED_MPMIN: Record<MotisStreetMode, number> = {
  WALK: 100, // ~6 km/h (ceiling)
  BIKE: 333, // ~20 km/h (ceiling)
};

export async function streetGridStops(args: {
  origin: { lat: number; lon: number };
  maxMinutes: number;
  mode: MotisStreetMode;
}): Promise<SlimStop[]> {
  const { origin, maxMinutes, mode } = args;

  const reachM = maxMinutes * SPEED_MPMIN[mode];
  const mPerLon = metersPerDegLon(origin.lat);
  const mPerLat = M_PER_DEG_LAT;

  // Grid cells in lat/lon.
  const dLatStep = GRID_SPACING_M / mPerLat;
  const dLonStep = GRID_SPACING_M / mPerLon;
  const nLat = Math.max(4, Math.round(reachM / GRID_SPACING_M));
  const nLon = nLat;

  const targets: { lat: number; lon: number; key: string }[] = [];
  for (let iy = -nLat; iy <= nLat; iy++) {
    for (let ix = -nLon; ix <= nLon; ix++) {
      // Skip the origin cell; the polygon already anchors on it.
      if (ix === 0 && iy === 0) continue;
      const lat = origin.lat + iy * dLatStep;
      const lon = origin.lon + ix * dLonStep;
      targets.push({ lat, lon, key: `g_${ix}_${iy}` });
    }
  }

  // Batch into MOTIS one-to-many requests (max 128 `many` per call).
  const batches: (typeof targets)[] = [];
  for (let i = 0; i < targets.length; i += MAX_MANY_PER_REQUEST) {
    batches.push(targets.slice(i, i + MAX_MANY_PER_REQUEST));
  }

  const durations = new Array<number | null>(targets.length).fill(null);
  await mapMotis(
    batches.map((batch, batchIdx) => ({ batch, batchIdx })),
    async ({ batch, batchIdx }) => {
      const { data, error } = await oneToManyPost({
        body: {
          one: `${origin.lat};${origin.lon}`,
          many: batch.map((t) => `${t.lat};${t.lon}`),
          mode,
          max: maxMinutes * 60,
          // Allow a bit of snapping slack so grid cells that land in a
          // backyard instead of on the street network still get matched.
          maxMatchingDistance: 80,
          arriveBy: false,
        },
      });
      if (error || !data) return;
      const arr = data as Array<{ duration?: number }>;
      const base = batchIdx * MAX_MANY_PER_REQUEST;
      for (let i = 0; i < arr.length; i++) {
        const d = arr[i]?.duration;
        // MOTIS returns a very large sentinel for unreachable cells; treat
        // anything beyond the budget as null so it doesn't contribute.
        if (d == null || d > maxMinutes * 60 + 1) continue;
        durations[base + i] = d;
      }
    },
  );

  const out: SlimStop[] = [];
  for (let i = 0; i < targets.length; i++) {
    const d = durations[i];
    if (d == null) continue;
    const t = targets[i];
    out.push({
      id: t.key,
      lat: t.lat,
      lon: t.lon,
      d: d / 60,
      m: "other",
    });
  }
  return out;
}
