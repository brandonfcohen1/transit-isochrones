import { NextResponse } from "next/server";
import type { Mode, Reachable } from "@motis-project/motis-client";
import { oneToAll } from "@/lib/motis";
import { buildIsochrone, type SlimStop, type StopMode, type StreetMode } from "@/lib/isochrone";
import { streetGridStops } from "@/lib/streetGrid";
import { LRU } from "@/lib/cache";

const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8080";

// MOTIS handles back-to-back one-to-all calls fine on its internal thread pool;
// an earlier cap of 8 was serializing the fan-out into 4-5 batches for no reason.
const BEST_CASE_CONCURRENCY = 64;

// Cache one-to-all results by (snapped origin, minutes, hour bucket). GTFS is
// static between feed reloads, so same inputs yield identical outputs. Repeat
// clicks at the same origin skip MOTIS entirely.
const CACHE = new LRU<string, SlimStop[]>(500);

function cacheKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode, safe: boolean): string {
  // ~11m snap at Philly's latitude — well below MOTIS's 25m matching default.
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  // Hour bucket: transit service patterns are stable within an hour.
  const hour = time.slice(0, 13); // "2026-04-20T14"
  return `${la},${lo},${minutes},${hour},${mode}${safe ? "S" : ""}`;
}

// Street-grid cache: independent of sample time (street graph is static).
// Key = (origin-4dp, minutes, mode).
const STREET_CACHE = new LRU<string, SlimStop[]>(100);
function streetKey(lat: number, lon: number, minutes: number, mode: StreetMode): string {
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  return `${la},${lo},${minutes},${mode}`;
}

// Pick the "highest" mode at a stop (rail > subway > tram > bus). A bus stop
// that's also a rail station should render as rail.
function coarseMode(modes?: string[] | null): StopMode {
  if (!modes || modes.length === 0) return "other";
  if (modes.includes("REGIONAL_RAIL")) return "rail";
  if (modes.includes("SUBWAY")) return "subway";
  if (modes.includes("TRAM")) return "tram";
  if (modes.includes("BUS")) return "bus";
  return "other";
}

function projectSlim(r: Reachable): SlimStop[] {
  const out: SlimStop[] = [];
  for (const p of r.all ?? []) {
    if (!p.place || p.duration == null) continue;
    out.push({
      id: p.place.stopId ?? `${p.place.lat.toFixed(5)},${p.place.lon.toFixed(5)}`,
      lat: p.place.lat,
      lon: p.place.lon,
      d: p.duration,
      m: coarseMode(p.place.modes),
    });
  }
  return out;
}

function mergeSlim(batches: SlimStop[][]): SlimStop[] {
  if (batches.length === 1) return batches[0];
  const best = new Map<string, SlimStop>();
  for (const batch of batches) {
    for (const s of batch) {
      const prev = best.get(s.id);
      if (!prev || prev.d > s.d) best.set(s.id, s);
    }
  }
  return Array.from(best.values());
}

// GET /api/isochrone?lat=..&lon=..&minutes=30&time=<iso>&mode=walk|bike&safe=true
// For best-case: pass `timesCsv=iso1,iso2,...`. Response is a slim envelope:
//   { polygon: Feature<MultiPolygon> | null, stops: SlimStop[], minutes, origin, mode }
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const minutes = Number(url.searchParams.get("minutes") ?? 30);
  const timesCsv = url.searchParams.get("timesCsv");
  const time = url.searchParams.get("time") ?? new Date().toISOString();
  const modeParam = url.searchParams.get("mode");
  const mode: StreetMode = modeParam === "bike" ? "bike" : "walk";
  const safe = url.searchParams.get("safe") === "true";
  // Precise-streets = replace the origin's Euclidean-circle contribution
  // with a MOTIS-routed grid of reachable cells. Adds ~100-500ms per query.
  const precise = url.searchParams.get("precise") === "true";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 90) {
    return NextResponse.json({ error: "minutes must be 1-90" }, { status: 400 });
  }

  const times = timesCsv ? timesCsv.split(",").filter(Boolean) : [time];
  if (times.length === 0) {
    return NextResponse.json({ error: "no sample times" }, { status: 400 });
  }

  // Mode controls the street leg MOTIS routes. In bike mode the rider is
  // assumed to have a bike throughout (bike both ways), which is the most
  // optimistic "where can I get?" model and matches classical bikeability
  // maps. A stricter park-and-ride model (bike→walk) is a follow-up.
  const streetMode: Mode = mode === "bike" ? "BIKE" : "WALK";
  const baseParams = {
    one: `${lat},${lon}`,
    maxTravelTime: minutes,
    arriveBy: false,
    transitModes: ["TRANSIT"] as Mode[],
    preTransitModes: [streetMode] as Mode[],
    postTransitModes: [streetMode] as Mode[],
    // Real OSM-routed transfers inside the transit graph — more accurate
    // than straight-line footpaths, especially at multi-modal hubs.
    useRoutedTransfers: true,
    // Bike riders cover a lot more ground than walkers in the same
    // wall-clock minutes, so lift the pre-transit cap closer to the
    // overall travel budget.
    ...(mode === "bike" ? { maxPreTransitTime: minutes * 60 } : {}),
  };

  // Split into cached vs uncached sample times.
  const missTimes: string[] = [];
  const hitBatches: SlimStop[][] = [];
  for (const t of times) {
    const k = cacheKey(lat, lon, minutes, t, mode, safe);
    const hit = CACHE.get(k);
    if (hit) hitBatches.push(hit);
    else missTimes.push(t);
  }

  let err: unknown = null;
  if (missTimes.length > 0) {
    const results = await parallelWithLimit(missTimes, BEST_CASE_CONCURRENCY, (t) =>
      oneToAll({ query: { ...baseParams, time: t } }),
    );
    const firstErr = results.find((r) => r.error);
    if (firstErr?.error) err = firstErr.error;
    else {
      for (let i = 0; i < missTimes.length; i++) {
        const slim = projectSlim(results[i].data as Reachable);
        CACHE.set(cacheKey(lat, lon, minutes, missTimes[i], mode, safe), slim);
        hitBatches.push(slim);
      }
    }
  }

  if (err) return NextResponse.json({ error: err }, { status: 502 });

  const stops = mergeSlim(hitBatches);
  // When precise mode is on, also fan out a street-routed grid of cells
  // around the origin. Each cell contributes a synthetic stop that the
  // contour builder unions with the transit reach, giving a real-street
  // polygon in the origin's walking/biking region (transit-extended
  // areas still use the fast Euclidean fallback). Grid cells are NOT
  // returned in the stops array — they aren't real transit stops and
  // shouldn't be drawn as such, and the extra payload is wasteful.
  const stopsForPoly: SlimStop[] = [...stops];
  if (precise) {
    const sk = streetKey(lat, lon, minutes, mode);
    let gridStops = STREET_CACHE.get(sk);
    if (!gridStops) {
      gridStops = await streetGridStops({
        origin: { lat, lon },
        maxMinutes: minutes,
        mode: mode === "bike" ? "BIKE" : "WALK",
        motisUrl: MOTIS_URL,
      });
      STREET_CACHE.set(sk, gridStops);
    }
    for (const g of gridStops) stopsForPoly.push(g);
  }
  // In precise mode, the 150m grid of MOTIS-routed cells dominates the
  // origin-reach region. We skip the synthetic-origin zero-cost stop so
  // the Euclidean straight-line distances to each grid cell don't beat
  // the routed durations and collapse the street shape into a circle.
  // Transit-stop patches still use the detour factor — their
  // remainder-radius is Euclidean.
  const polygon = buildIsochrone({ lat, lon }, stopsForPoly, minutes, {
    mode,
    safe,
    skipOriginStop: precise,
  });

  return NextResponse.json(
    { polygon, stops, minutes, origin: { lat, lon }, mode, safe, precise },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
  );
}

async function parallelWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
