import { NextResponse } from "next/server";
import type { Mode, Reachable } from "@motis-project/motis-client";
import { oneToAll } from "@/lib/motis";
import { buildIsochrone, type SlimStop, type StopMode } from "@/lib/isochrone";
import { LRU } from "@/lib/cache";

// MOTIS handles back-to-back one-to-all calls fine on its internal thread pool;
// an earlier cap of 8 was serializing the fan-out into 4-5 batches for no reason.
const BEST_CASE_CONCURRENCY = 64;

// Cache one-to-all results by (snapped origin, minutes, hour bucket). GTFS is
// static between feed reloads, so same inputs yield identical outputs. Repeat
// clicks at the same origin skip MOTIS entirely.
const CACHE = new LRU<string, SlimStop[]>(500);

function cacheKey(lat: number, lon: number, minutes: number, time: string): string {
  // ~11m snap at Philly's latitude — well below MOTIS's 25m matching default.
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  // Hour bucket: transit service patterns are stable within an hour.
  const hour = time.slice(0, 13); // "2026-04-20T14"
  return `${la},${lo},${minutes},${hour}`;
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

// GET /api/isochrone?lat=..&lon=..&minutes=30&time=<iso>
// For best-case: pass `timesCsv=iso1,iso2,...`. Response is a slim envelope:
//   { polygon: Feature<MultiPolygon> | null, stops: SlimStop[], minutes, origin }
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const minutes = Number(url.searchParams.get("minutes") ?? 30);
  const timesCsv = url.searchParams.get("timesCsv");
  const time = url.searchParams.get("time") ?? new Date().toISOString();

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

  const baseParams = {
    one: `${lat},${lon}`,
    maxTravelTime: minutes,
    arriveBy: false,
    transitModes: ["TRANSIT"] as Mode[],
    preTransitModes: ["WALK"] as Mode[],
    postTransitModes: ["WALK"] as Mode[],
  };

  // Split into cached vs uncached sample times.
  const missTimes: string[] = [];
  const hitBatches: SlimStop[][] = [];
  for (const t of times) {
    const k = cacheKey(lat, lon, minutes, t);
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
        CACHE.set(cacheKey(lat, lon, minutes, missTimes[i]), slim);
        hitBatches.push(slim);
      }
    }
  }

  if (err) return NextResponse.json({ error: err }, { status: 502 });

  const stops = mergeSlim(hitBatches);
  const polygon = buildIsochrone({ lat, lon }, stops, minutes);

  return NextResponse.json(
    { polygon, stops, minutes, origin: { lat, lon } },
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
