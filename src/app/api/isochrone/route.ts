import { NextResponse } from "next/server";
import type { Mode, Reachable } from "@motis-project/motis-client";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { oneToAll } from "@/lib/motis";
import { buildIsochrone, type SlimStop, type StopMode, type StreetMode } from "@/lib/isochrone";
import { streetGridStops } from "@/lib/streetGrid";
import { graphIsochrone } from "@/lib/graphIsochrone";
import { LRU } from "@/lib/cache";
import { mapMotis } from "@/lib/motisLimiter";

// Cache one-to-all results by (snapped origin, minutes, hour bucket). GTFS is
// static between feed reloads, so same inputs yield identical outputs. Repeat
// clicks at the same origin skip MOTIS entirely.
const CACHE = new LRU<string, SlimStop[]>(500);

function cacheKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode, safe: boolean, modesKey: string): string {
  // ~11m snap at Philly's latitude — well below MOTIS's 25m matching default.
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  // Full minute precision in the key. Earlier versions bucketed to the hour,
  // which silently collapsed the 12 samples/hour from best-case scans into
  // one LRU slot (last-write-wins) — on any cached repeat, 11/12 samples
  // returned the same object. Per-minute keys cost more LRU slots but make
  // the cache faithful to what was computed.
  const minute = time.slice(0, 16); // "2026-04-20T14:25"
  return `${la},${lo},${minutes},${minute},${mode}${safe ? "S" : ""},${modesKey}`;
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
const GRAPH_CACHE = new LRU<string, FeatureCollection<Polygon | MultiPolygon> | null>(200);

// Rail sub-sample cache. Keyed by (origin, minutes, mode, time-set).
// Warm repeats skip the 36 × oneToAll rail-only calls entirely.
const RAIL_SUB_CACHE = new LRU<string, SlimStop[]>(200);

function graphKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode, modesKey: string): string {
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lon * 1e4) / 1e4;
  const minute = time.slice(0, 16);
  return `${la},${lo},${minutes},${minute},${mode},${modesKey}`;
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
//   { polygon: FeatureCollection<MultiPolygon> | null, stops: SlimStop[], minutes, origin, mode }
// The FeatureCollection holds 1-3 band features, each tagged with a `band`
// property (1=innermost). Client stacks them with graduated opacity.
// Best-case cold runs ~2-5s; longer budgets (60min) peak around 5s after
// the adaptive cell-size pass. Default route timeout on some Next
// adapters is 30s; lift it so cold queries have room. Warm hits <15ms.
export const maxDuration = 60;

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
  // Two-stage rendering flags:
  //   stopsOnly=true   → return after oneToAll; skip the slow probe+graph.
  //                      Client renders dots at ~200ms cold.
  //   polygonOnly=true → omit `stops` from the response body (client has
  //                      them from the stops-only fetch). Same compute
  //                      cost, smaller payload.
  // Both false (default) → full response, back-compat.
  const stopsOnly = url.searchParams.get("stopsOnly") === "true";
  const polygonOnly = url.searchParams.get("polygonOnly") === "true";
  // transitModes=BUS,SUBWAY,TRAM,REGIONAL_RAIL (any subset). Missing or
  // empty → default to all (TRANSIT). Used both for troubleshooting
  // ("does Regional Rail actually reach Ardmore?") and as a real user
  // feature ("show me bus-only reach"). We forward verbatim to MOTIS
  // whose `transitModes` accepts the same enum; unknown tokens get
  // silently dropped at the MOTIS side.
  const transitModesCsv = url.searchParams.get("transitModes");
  const ALLOWED_TRANSIT_MODES = new Set(["BUS", "SUBWAY", "TRAM", "REGIONAL_RAIL"]);
  const transitModes: Mode[] = (() => {
    if (!transitModesCsv) return ["TRANSIT"] as Mode[];
    const parsed = transitModesCsv.split(",").map((s) => s.trim()).filter((s) => ALLOWED_TRANSIT_MODES.has(s));
    return parsed.length === 0 ? ["TRANSIT"] as Mode[] : (parsed as Mode[]);
  })();
  const allModes = transitModes.length === 1 && transitModes[0] === "TRANSIT";
  // Compact key fragment for cache keys so BUS-only vs SUBWAY-only don't
  // collide. All-modes (default) normalizes to "T" so existing cache
  // entries created before this flag existed still fit.
  const modesKey = allModes ? "T" : [...transitModes].sort().join("+");

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

  // Phase timings emitted as `Server-Timing` so devtools shows the
  // breakdown per request. Names are short to stay within the header
  // length most CDNs strip at.
  const t0 = performance.now();
  const timings: Array<{ name: string; ms: number }> = [];
  function mark(name: string, since: number) {
    timings.push({ name, ms: performance.now() - since });
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
    transitModes,
    preTransitModes: [streetMode] as Mode[],
    postTransitModes: [streetMode] as Mode[],
    // Cap at 3 transfers — chains beyond 3 vehicles are rarely
    // realistic and MOTIS's default ("hardcoded very high") can
    // produce odd paths at budget-limit cells.
    maxTransfers: 3,
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
    const k = cacheKey(lat, lon, minutes, t, mode, safe, modesKey);
    const hit = CACHE.get(k);
    if (hit) byTime.set(t, hit);
    else missTimes.push(t);
  }

  let err: unknown = null;
  if (missTimes.length > 0) {
    const tOneToAll = performance.now();
    const results = await mapMotis(missTimes, (t) =>
      oneToAll({ query: { ...baseParams, time: t } }),
    );
    mark(`ota[${missTimes.length}]`, tOneToAll);
    const firstErr = results.find((r) => r.error);
    if (firstErr?.error) err = firstErr.error;
    else {
      for (let i = 0; i < missTimes.length; i++) {
        const slim = projectSlim(results[i].data as Reachable);
        CACHE.set(cacheKey(lat, lon, minutes, missTimes[i], mode, safe, modesKey), slim);
        byTime.set(missTimes[i], slim);
      }
    }
  }

  if (err) return NextResponse.json({ error: err }, { status: 502 });

  // Rail-specific sub-hourly sampling. The main oneToAll above runs at
  // every `times[]` entry (hourly for best-case). A train that departs
  // at :12 is missed by :00/:30 samples. Instead of the old
  // `probeRailReach` (N stations × plan() with timetableView, 14-18s
  // cold), run rail-only oneToAll at 15-min sub-samples of the same
  // window — tens of cheap one-to-all calls vs tens of expensive
  // plan() calls. MOTIS returns ~50ms for rail-only one-to-all because
  // it only walks the REGIONAL_RAIL half of the transit graph. Cached
  // under the full base-time array so warm repeats skip MOTIS entirely.
  //
  // Skipped entirely if the user has toggled Regional Rail off.
  const railEnabled = allModes || transitModes.includes("REGIONAL_RAIL" as Mode);
  const railOnlyStops = new Map<string, SlimStop>();
  if (railEnabled && method === "graph") {
    const rsKey = `${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4},${minutes},${mode}|${times.join(",")}`;
    const cached = RAIL_SUB_CACHE.get(rsKey);
    if (cached) {
      for (const s of cached) railOnlyStops.set(s.id, s);
    } else {
      const subSamples: string[] = [];
      for (const t of times) {
        const base = new Date(t);
        for (const off of [15, 30, 45]) {
          const d = new Date(base.getTime() + off * 60_000);
          subSamples.push(d.toISOString());
        }
      }
      if (subSamples.length > 0) {
        const tRail = performance.now();
        const railParams = { ...baseParams, transitModes: ["REGIONAL_RAIL"] as Mode[], maxTransfers: 1 };
        const railResults = await mapMotis(subSamples, (t) =>
          oneToAll({ query: { ...railParams, time: t } }),
        );
        for (const r of railResults) {
          if (r.error || !r.data) continue;
          for (const p of (r.data as Reachable).all ?? []) {
            if (!p.place || p.duration == null) continue;
            const m = coarseMode(p.place.modes);
            if (m !== "rail") continue;
            const id = p.place.stopId ?? `${p.place.lat.toFixed(5)},${p.place.lon.toFixed(5)}`;
            const prev = railOnlyStops.get(id);
            if (!prev || prev.d > p.duration) {
              railOnlyStops.set(id, {
                id,
                lat: p.place.lat,
                lon: p.place.lon,
                d: p.duration,
                m: "rail",
                n: p.place.name || undefined,
              });
            }
          }
        }
        mark(`rail-sub[${subSamples.length}/${railOnlyStops.size}]`, tRail);
        RAIL_SUB_CACHE.set(rsKey, Array.from(railOnlyStops.values()));
      }
    }
  }

  const hitBatches = Array.from(byTime.values());
  const stopsBase = mergeSlim(hitBatches);
  // Merge rail-only-sub with base stops. Prefer lower duration per id.
  const stopsById = new Map<string, SlimStop>();
  for (const s of stopsBase) stopsById.set(s.id, s);
  for (const [id, s] of railOnlyStops) {
    const prev = stopsById.get(id);
    if (!prev || prev.d > s.d) stopsById.set(id, s);
  }
  const stops = Array.from(stopsById.values());

  // Early return for stops-only: skip probe + graph so the client can
  // render dots while the polygon computes in a parallel request.
  if (stopsOnly) {
    mark("total", t0);
    return NextResponse.json(
      { stops, minutes, origin: { lat, lon }, mode, safe, method, stopsOnly: true },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "Server-Timing": timings.map((t) => `${t.name};dur=${t.ms.toFixed(1)}`).join(", "),
        },
      },
    );
  }

  // For the graph call, use the top-K sample times by reachable-stops
  // count. Single-time queries → just that one time. Best-case scans
  // → K representative peaks. K=2 covers AM + PM rush variance for
  // bus/subway; rail timing variance is already covered by the
  // rail-only 15-min sub-sampling above, so the graph intermodal
  // doesn't need to spread across more peaks. K=3+ meaningfully
  // raises cold latency without improving coverage.
  const GRAPH_SAMPLE_K = 2;
  const sortedTimes = Array.from(byTime.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, Math.min(GRAPH_SAMPLE_K, byTime.size))
    .map(([t]) => t);
  const graphTimes = sortedTimes.length > 0 ? sortedTimes : [time];

  let polygon: FeatureCollection<Polygon | MultiPolygon> | null;
  if (method === "graph") {
    // Cache key includes all graph-sample times so best-case unions
    // and single-time queries don't collide.
    const gk = graphKey(lat, lon, minutes, graphTimes.join("|"), mode, modesKey);
    const cached = GRAPH_CACHE.get(gk);
    if (cached !== undefined) {
      polygon = cached;
    } else {
      // Rail anchors = rail stops in the merged `stops` list. This now
      // includes both the base hourly oneToAll AND the rail-only 15-min
      // sub-samples run above, so it catches peak trains that depart at
      // :12/:23/:38/:47-style off-clock moments. The old plan()-per-
      // station probe was replaced by that sub-sample pass: same rail
      // coverage, ~50× faster (0.3s vs 14-18s).
      // Anchors for the anchor-walk disk step in graphIsochrone.
      // Include rail AND subway (SEPTA's M / NHSL is tagged SUBWAY in
      // MOTIS; without it, NHSL stations in suburban PA rely only on
      // the 18m-match intermodal pass and produce near-zero walksheds
      // because suburban streets sit 40-80m from the grid). Dedup by
      // id, keeping the lowest reach duration across the day.
      const railAnchors: Array<{ lat: number; lon: number; reachedAtMinutes: number; name: string; stopId: string }> = [];
      const seenAnchors = new Set<string>();
      for (const s of stops) {
        if (s.m !== "rail" && s.m !== "subway") continue;
        if (seenAnchors.has(s.id)) continue;
        seenAnchors.add(s.id);
        railAnchors.push({ lat: s.lat, lon: s.lon, reachedAtMinutes: s.d, name: s.n ?? s.id, stopId: s.id });
      }

      // Bbox: envelope around reachable transit stops + walking buffer
      // at each remaining budget. Critically, rail anchors found via
      // plan() are often outside `oneToAll`'s stops list, so we add
      // them here too — otherwise their walking disks land off-grid
      // and never contribute to the polygon.
      const bboxSeedStops: Array<{ lat: number; lon: number; d: number }> = [
        ...stops,
        ...railAnchors.map((a) => ({ lat: a.lat, lon: a.lon, d: a.reachedAtMinutes })),
      ];
      const bbox = stopsEnvelope({ lat, lon }, bboxSeedStops as SlimStop[], minutes, mode);
      const tGraph = performance.now();
      polygon = await graphIsochrone({
        origin: { lat, lon },
        maxMinutes: minutes,
        mode,
        times: graphTimes,
        bbox,
        reachAnchors: railAnchors,
        transitModes,
      });
      mark(`graph[${graphTimes.length}x]`, tGraph);
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

  mark("total", t0);
  const serverTiming = timings.map((t) => `${t.name};dur=${t.ms.toFixed(1)}`).join(", ");
  const body = polygonOnly
    ? { polygon, minutes, origin: { lat, lon }, mode, safe, precise, method, polygonOnly: true }
    : { polygon, stops, minutes, origin: { lat, lon }, mode, safe, precise, method };
  return NextResponse.json(
    body,
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300",
        "Server-Timing": serverTiming,
      },
    },
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
