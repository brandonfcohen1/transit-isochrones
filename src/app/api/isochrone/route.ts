import { NextResponse } from "next/server";
import type { Mode, Reachable } from "@motis-project/motis-client";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { oneToAll } from "@/lib/motis";
import { buildIsochrone, type SlimStop, type StopMode, type StreetMode } from "@/lib/isochrone";
import { streetGridStops } from "@/lib/streetGrid";
import { graphIsochrone } from "@/lib/graphIsochrone";
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

// Graph-isochrone polygon cache. Time matters (transit schedules vary by
// hour), but within an hour-bucket the polygon is stable.
const GRAPH_CACHE = new LRU<string, Feature<Polygon | MultiPolygon> | null>(200);
function graphKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode): string {
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  const hour = time.slice(0, 13);
  return `${la},${lo},${minutes},${hour},${mode}`;
}

// Pick the "highest" mode at a stop (rail > subway > tram > bus). A bus stop
// that's also a rail station should render as rail.
function coarseMode(modes?: string[] | null): StopMode {
  if (!modes || modes.length === 0) return "other";
  if (modes.includes("REGIONAL_RAIL")) return "rail";
  if (modes.includes("SUBWAY")) return "subway";
  // SEPTA calls these trolleys, not trams — normalize on ingest.
  if (modes.includes("TRAM")) return "trolley";
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
      n: p.place.name || undefined,
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
  // method=graph (default): poll MOTIS one-to-many-intermodal on a dense
  // grid so the polygon respects the transit+street graph end-to-end
  // (rivers without bridges, rail yards, etc.). method=approx falls back
  // to the fast Euclidean-disk approximation. For best-case scans, we
  // still run graph once — at whichever sample time has the most
  // reachable stops — rather than N graph calls (too slow) or approx
  // (low fidelity). The stops list is still the union over all times.
  const method = url.searchParams.get("method") === "approx" ? "approx" : "graph";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    return NextResponse.json({ error: "minutes must be 1-60" }, { status: 400 });
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

  // Keep stops keyed to their sample time so we can pick the best one
  // for the graph query below. Cache per-time as before.
  const byTime = new Map<string, SlimStop[]>();
  const missTimes: string[] = [];
  for (const t of times) {
    const k = cacheKey(lat, lon, minutes, t, mode, safe);
    const hit = CACHE.get(k);
    if (hit) byTime.set(t, hit);
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
        byTime.set(missTimes[i], slim);
      }
    }
  }

  if (err) return NextResponse.json({ error: err }, { status: 502 });

  const hitBatches = Array.from(byTime.values());
  const stops = mergeSlim(hitBatches);

  // Pick the sample time with the most reachable stops for the graph
  // call. For single-time queries this is a no-op; for best-case scans
  // it biases toward peak-transit departures where the polygon covers
  // the largest area.
  let bestTime = time;
  let bestCount = -1;
  for (const [t, batch] of byTime) {
    if (batch.length > bestCount) { bestCount = batch.length; bestTime = t; }
  }

  let polygon: Feature<Polygon | MultiPolygon> | null;
  if (method === "graph") {
    // Bbox: tight envelope around reachable transit stops + a
    // full-budget walking/biking buffer at each stop's own remainder.
    // Far cheaper than covering the worst-case Regional-Rail reach, and
    // it won't miss anything — a cell not reachable via any stop also
    // isn't reachable period.
    const bbox = stopsEnvelope({ lat, lon }, stops, minutes, mode);
    const gk = graphKey(lat, lon, minutes, bestTime, mode);
    const cached = GRAPH_CACHE.get(gk);
    if (cached !== undefined) {
      polygon = cached;
    } else {
      polygon = await graphIsochrone({
        origin: { lat, lon },
        maxMinutes: minutes,
        mode,
        time: bestTime,
        motisUrl: MOTIS_URL,
        bbox,
      });
      GRAPH_CACHE.set(gk, polygon);
    }
  } else {
    // Approximation path (fast best-case scans, or explicit method=approx).
    // When precise is also set, a street-routed grid around the origin
    // replaces the Euclidean origin circle.
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
    polygon = buildIsochrone({ lat, lon }, stopsForPoly, minutes, {
      mode,
      safe,
      skipOriginStop: precise,
    });
  }

  return NextResponse.json(
    { polygon, stops, minutes, origin: { lat, lon }, mode, safe, precise, method },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
  );
}

// Bbox for graph-mode gridding. Seed from reachable-stop bbox + each
// stop's own remaining walk/bike buffer; fall back to a conservative
// origin-centered circle when no stops were reached.
function stopsEnvelope(
  origin: { lat: number; lon: number },
  stops: SlimStop[],
  maxMinutes: number,
  mode: StreetMode,
): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  // Ceiling m/min so the buffer is pessimistic enough to not clip real reach.
  const mPerMin = mode === "bike" ? (22 * 1000) / 60 : (6 * 1000) / 60;
  const originRadius = maxMinutes * mPerMin;
  let minLat = origin.lat - originRadius / mPerLat;
  let maxLat = origin.lat + originRadius / mPerLat;
  let minLon = origin.lon - originRadius / mPerLon;
  let maxLon = origin.lon + originRadius / mPerLon;
  for (const s of stops) {
    const remaining = maxMinutes - s.d;
    if (remaining <= 0) continue;
    const rM = remaining * mPerMin;
    const dLat = rM / mPerLat;
    const dLon = rM / mPerLon;
    if (s.lat - dLat < minLat) minLat = s.lat - dLat;
    if (s.lat + dLat > maxLat) maxLat = s.lat + dLat;
    if (s.lon - dLon < minLon) minLon = s.lon - dLon;
    if (s.lon + dLon > maxLon) maxLon = s.lon + dLon;
  }
  return { minLat, maxLat, minLon, maxLon };
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
