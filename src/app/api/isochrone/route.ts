import { NextResponse } from "next/server";
import type { Mode, PlanResponse, Reachable } from "@motis-project/motis-client";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { oneToAll, plan, motisTimeoutSignal } from "@/lib/motis";
import type { SlimStop, StopMode, StreetMode } from "@/lib/types";
import { graphIsochrone } from "@/lib/graphIsochrone";
import { LRU, cacheStats } from "@/lib/cache";
import { mapMotis } from "@/lib/motisLimiter";
import { rateLimit } from "@/lib/rateLimit";

// Cache one-to-all results by (snapped origin, minutes, hour bucket). GTFS is
// static between feed reloads, so same inputs yield identical outputs. Repeat
// clicks at the same origin skip MOTIS entirely.
const CACHE = new LRU<string, SlimStop[]>(500);

// Origin-snap precision for cache keys. 3 decimal places ≈ 110 m at Philly's
// latitude (~85 m in longitude). Nearby clicks within ~100-150 m share a
// cache bucket, so a user exploring a neighborhood mostly hits warm cache
// after the first query in each rough area. Trade-off: the polygon returned
// to a "nearby but not identical" click was computed for the prior origin,
// so it's off by up to ~150 m. On a 30-min polygon spanning ~5 km that's
// imperceptible. Tighter snap (4 dp = ~11 m) meant only exact re-clicks hit.
const SNAP_DP = 1e3;
function snap(n: number): number {
  return Math.round(n * SNAP_DP) / SNAP_DP;
}

function cacheKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode, modesKey: string): string {
  // Full minute precision in the key. Earlier versions bucketed to the hour,
  // which silently collapsed the 12 samples/hour from best-case scans into
  // one LRU slot (last-write-wins) — on any cached repeat, 11/12 samples
  // returned the same object. Per-minute keys cost more LRU slots but make
  // the cache faithful to what was computed.
  const minute = time.slice(0, 16); // "2026-04-20T14:25"
  return `${snap(lat)},${snap(lon)},${minutes},${minute},${mode},${modesKey}`;
}

// Graph-isochrone polygon cache. Time matters (transit schedules vary by
// hour), but within an hour-bucket the polygon is stable.
const GRAPH_CACHE = new LRU<string, FeatureCollection<Polygon | MultiPolygon> | null>(200);


// Rail sub-sample cache. Keyed by (origin, minutes, mode, time-set).
// Warm repeats skip the 36 × oneToAll rail-only calls entirely.
const RAIL_SUB_CACHE = new LRU<string, SlimStop[]>(200);

// Per-stop plan() override cache for the rail-reach correction (see
// railVerify pass below). Keyed by (origin, mode, day-window, stopId)
// so same-day repeats skip MOTIS. null = MOTIS returned no itinerary
// (stop genuinely unreachable from origin).
const RAIL_PLAN_CACHE = new LRU<string, number | null>(2000);

function graphKey(lat: number, lon: number, minutes: number, time: string, mode: StreetMode, modesKey: string): string {
  const minute = time.slice(0, 16);
  return `${snap(lat)},${snap(lon)},${minutes},${minute},${mode},${modesKey}`;
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

// GET /api/isochrone?lat=..&lon=..&minutes=30&time=<iso>&mode=walk|bike
// For best-case: pass `timesCsv=iso1,iso2,...`.
// Optional: stopsOnly=true (skip polygon), polygonOnly=true (skip stops),
//           transitModes=BUS,SUBWAY,TRAM,REGIONAL_RAIL subset.
// Response is a slim envelope:
//   { polygon: FeatureCollection<MultiPolygon> | null, stops: SlimStop[], minutes, origin, mode }
// Best-case cold runs ~2-5s; longer budgets (60min) peak around 5s after
// the adaptive cell-size pass. Default route timeout on some Next
// adapters is 30s; lift it so cold queries have room. Warm hits <15ms.
export const maxDuration = 60;

export async function GET(req: Request) {
  // 30 req/min burst, 0.5 req/sec sustained per IP. A normal slider
  // session fires one call per deliberate Run click — well under the
  // budget. A scripted abuser gets wedged at 1 call every 2 seconds
  // regardless of how many expensive params they cram in.
  const rl = rateLimit(req, { capacity: 30, refillPerSec: 0.5 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const minutes = Number(url.searchParams.get("minutes") ?? 30);
  const timesCsv = url.searchParams.get("timesCsv");
  const time = url.searchParams.get("time") ?? new Date().toISOString();
  const modeParam = url.searchParams.get("mode");
  const mode: StreetMode = modeParam === "bike" ? "bike" : "walk";
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
  // Coverage-area bbox. Tracks the OSM extract baked into the MOTIS
  // dataset (5 PA counties + Wilmington/Newark DE + Trenton NJ — i.e.
  // SEPTA's Regional Rail terminal envelope). Out-of-area origins
  // otherwise consume a timesCsv fan-out of oneToAll calls before MOTIS
  // returns empty — cheap DoS vector. Keep this in sync with
  // data/septa-region.osm.pbf's bbox.
  if (lat < 39.55 || lat > 40.45 || lon < -76.0 || lon > -74.65) {
    return NextResponse.json({ error: "origin outside coverage area" }, { status: 400 });
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    return NextResponse.json({ error: "minutes must be 1-60" }, { status: 400 });
  }

  const times = timesCsv ? timesCsv.split(",").filter(Boolean) : [time];
  if (times.length === 0) {
    return NextResponse.json({ error: "no sample times" }, { status: 400 });
  }
  // Cap sample-time count. Prod client sends at most 18 (hourly
  // 5am–11pm); 24 gives headroom without opening the N×MOTIS-call
  // amplification that a crafted 200-entry timesCsv produces.
  const MAX_TIMES = 24;
  if (times.length > MAX_TIMES) {
    return NextResponse.json({ error: `timesCsv limited to ${MAX_TIMES} entries` }, { status: 400 });
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
    const k = cacheKey(lat, lon, minutes, t, mode, modesKey);
    const hit = CACHE.get(k);
    cacheStats.ota++;
    if (hit) { cacheStats.otaHit++; byTime.set(t, hit); }
    else missTimes.push(t);
  }
  const otaCacheHits = times.length - missTimes.length;

  let err: unknown = null;
  if (missTimes.length > 0) {
    const tOneToAll = performance.now();
    const results = await mapMotis(missTimes, (t) =>
      oneToAll({ query: { ...baseParams, time: t }, signal: motisTimeoutSignal() }),
    );
    mark(`ota[${missTimes.length}]`, tOneToAll);
    const firstErr = results.find((r) => r.error);
    if (firstErr?.error) {
      err = firstErr.error;
    } else {
      for (let i = 0; i < missTimes.length; i++) {
        const slim = projectSlim(results[i].data as Reachable);
        CACHE.set(cacheKey(lat, lon, minutes, missTimes[i], mode, modesKey), slim);
        byTime.set(missTimes[i], slim);
      }
    }
  }

  if (err) {
    // Log the raw MOTIS error for operators; client gets a sanitized
    // message so we don't leak internal paths/IDs.
    console.error("oneToAll error", err);
    return NextResponse.json({ error: "routing service error" }, { status: 502 });
  }

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
  if (railEnabled) {
    const rsKey = `${snap(lat)},${snap(lon)},${minutes},${mode}|${times.join(",")}`;
    const cached = RAIL_SUB_CACHE.get(rsKey);
    cacheStats.railSub++;
    if (cached) {
      cacheStats.railSubHit++;
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
        // Inflate the search budget by 15 min so the plan() verify pass
        // below can recover stops that oneToAll over-reports (notably
        // AIR / Chestnut Hill East / Fox Chase, which read 5-12 min
        // high from oneToAll's RAPTOR rounds). Filtered back to the
        // user's `minutes` after correction.
        const railParams = { ...baseParams, maxTravelTime: minutes + 15, transitModes: ["REGIONAL_RAIL"] as Mode[], maxTransfers: 1 };
        const railResults = await mapMotis(subSamples, (t) =>
          oneToAll({ query: { ...railParams, time: t }, signal: motisTimeoutSignal() }),
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

  // Rail-reach correction. MOTIS one-to-all under-reports duration on
  // long branch-lines (AIR, Chestnut Hill East, Fox Chase, Trenton tail)
  // by 5-12 min — RAPTOR rounds don't always extend a single vehicle's
  // reach to its remaining stops, so each downstream stop reads as if
  // it needed a fresh boarding. plan() solves origin → one-target with
  // full trip extension and gets the right answer.
  //
  // Targeted to *marginal* stops: those whose oneToAll d is within the
  // observed inflation band of the budget cutoff. Stops well inside
  // budget are visually equivalent at d=15 vs d=18 — not worth a plan()
  // call. Stops we'd correct from above-budget into-budget are the
  // visible win (airports, etc).
  //
  // Skipped for single-time queries (user wants "right now" timing).
  const RAIL_VERIFY_MARGIN = 12;
  if (railEnabled && times.length > 1) {
    const railCandidates = Array.from(stopsById.values()).filter(
      (s) => s.m === "rail" && s.d >= minutes - RAIL_VERIFY_MARGIN,
    );
    const earliest = times.slice().sort()[0];
    // 4 h window from the earliest sample is plenty: AIR / CHE / FOX
    // run every ~30 min, so the next-train wait at the optimal sample
    // is bounded. Keeps each plan() call to ~200-500 ms instead of the
    // multi-second cost of a true 18 h timetableView fan-out.
    const planWindow = 4 * 3600;
    const planCacheKeyFor = (id: string) =>
      `${snap(lat)},${snap(lon)},${minutes},${earliest},${mode},${modesKey}|${id}`;
    const tPlan = performance.now();
    const planResults = await mapMotis(railCandidates, async (s) => {
      const ck = planCacheKeyFor(s.id);
      const cached = RAIL_PLAN_CACHE.get(ck);
      if (cached !== undefined) return [s, cached] as const;
      const r = await plan({
        signal: motisTimeoutSignal(),
        query: {
          fromPlace: `${lat},${lon}`,
          toPlace: s.id,
          time: earliest,
          searchWindow: planWindow,
          arriveBy: false,
          transitModes,
          preTransitModes: [streetMode],
          postTransitModes: [streetMode],
          directModes: [streetMode],
          maxTransfers: 3,
          useRoutedTransfers: true,
          detailedLegs: false,
          detailedTransfers: false,
        },
      });
      if (r.error || !r.data) {
        RAIL_PLAN_CACHE.set(ck, null);
        return [s, null] as const;
      }
      const its = (r.data as PlanResponse).itineraries ?? [];
      if (its.length === 0) {
        RAIL_PLAN_CACHE.set(ck, null);
        return [s, null] as const;
      }
      const minDurMin = Math.round(Math.min(...its.map((it) => it.duration)) / 60);
      RAIL_PLAN_CACHE.set(ck, minDurMin);
      return [s, minDurMin] as const;
    });
    let corrected = 0;
    for (const [s, planD] of planResults) {
      if (planD != null && planD < s.d) {
        stopsById.set(s.id, { ...s, d: planD });
        corrected++;
      }
    }
    mark(`rail-plan[${railCandidates.length}/${corrected}]`, tPlan);
  }

  // Final budget filter — rail-sub widened the search to capture stops
  // that the plan-verify pass might pull back into range, so cull
  // anything still over the user's minutes.
  const stops = Array.from(stopsById.values()).filter((s) => s.d <= minutes);

  // Early return for stops-only: skip probe + graph so the client can
  // render dots while the polygon computes in a parallel request.
  if (stopsOnly) {
    mark("total", t0);
    mark(`ota-hit[${otaCacheHits}/${times.length}]`, t0);
    return NextResponse.json(
      { stops, minutes, origin: { lat, lon }, mode, stopsOnly: true },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "Server-Timing": timings.map((t) => `${t.name};dur=${t.ms.toFixed(1)}`).join(", "),
        },
      },
    );
  }

  // For the graph call, use the top-K sample times by reachable-stops
  // count. K=1 uses the single peak-coverage hour — rail variance is
  // already handled by the 15-min rail-sub sampling above, and
  // bus/subway reach doesn't vary much hour-to-hour (headways
  // throughout the service day are similar). An earlier K=2 was
  // measured to add ~1s of cold latency for sub-1% polygon-area
  // difference; reverted to K=1 once rail-sub was in place.
  const GRAPH_SAMPLE_K = 1;
  const sortedTimes = Array.from(byTime.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, Math.min(GRAPH_SAMPLE_K, byTime.size))
    .map(([t]) => t);
  const graphTimes = sortedTimes.length > 0 ? sortedTimes : [time];

  let polygon: FeatureCollection<Polygon | MultiPolygon> | null;
  // Cache key includes all graph-sample times so best-case unions and
  // single-time queries don't collide.
  const gk = graphKey(lat, lon, minutes, graphTimes.join("|"), mode, modesKey);
  const cached = GRAPH_CACHE.get(gk);
  cacheStats.graph++;
  if (cached !== undefined) {
    cacheStats.graphHit++;
    polygon = cached;
    mark("graph-hit", t0);
  } else {
    // Anchors for the walkshed-disk rasterization in graphIsochrone.
    // All transit modes (rail, subway, trolley) go through the same
    // filter — they all suffer the same intermodal-grid under-coverage
    // wherever OSM walkable ways sit > 18 m from a target cell, and
    // there's no principled reason to treat them differently.
    //
    // Dedup twice:
    //   - by stopId (a stop may appear in multiple sample times)
    //   - by a ~330 m spatial cell. At that radius rail stations
    //     (~1-3 km apart) all survive; subway stops (~500-800 m)
    //     mostly survive; trolley stops (~150-250 m in dense corridors)
    //     collapse roughly 3→1, which is fine because adjacent
    //     trolley-stop walksheds overlap heavily at typical late-budget
    //     disk radii (400+ m). 110 m dedup left trolley counts at
    //     100+ per query, which spawned 2+ s of redundant one-to-many
    //     MOTIS calls; 330 m keeps coverage and drops the cost by 2-3×.
    //
    // Cost is further capped by rasterAnchor's internal half-budget
    // gate (close-in anchors are already covered by the main intermodal
    // grid, so their walk-fill is skipped there).
    const railAnchors: Array<{ lat: number; lon: number; reachedAtMinutes: number; name: string; stopId: string }> = [];
    const seenAnchorIds = new Set<string>();
    const seenAnchorCells = new Set<string>();
    // 0.003° ≈ 333 m lat / 255 m lon at Philly's latitude.
    const ANCHOR_DEDUP_STEP = 0.003;
    for (const s of stops) {
      if (s.m !== "rail" && s.m !== "subway" && s.m !== "trolley") continue;
      if (seenAnchorIds.has(s.id)) continue;
      const cellKey = `${Math.round(s.lat / ANCHOR_DEDUP_STEP)},${Math.round(s.lon / ANCHOR_DEDUP_STEP)}`;
      if (seenAnchorCells.has(cellKey)) continue;
      seenAnchorIds.add(s.id);
      seenAnchorCells.add(cellKey);
      railAnchors.push({ lat: s.lat, lon: s.lon, reachedAtMinutes: s.d, name: s.n ?? s.id, stopId: s.id });
    }

    // Bbox: envelope around reachable transit stops + walking buffer
    // at each remaining budget.
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

  mark("total", t0);
  // Process-wide cache hit rates, surfaced alongside phase timings so
  // devtools' Server-Timing panel shows both "how long this took" and
  // "how often requests escape MOTIS". Rate is 0-100; suffix "pct" so
  // it doesn't get parsed as a duration.
  const rate = (hit: number, total: number): string =>
    total === 0 ? "0" : String(Math.round((hit * 100) / total));
  const cacheSummary = `cache-ota;desc=${rate(cacheStats.otaHit, cacheStats.ota)}pct, cache-graph;desc=${rate(cacheStats.graphHit, cacheStats.graph)}pct, cache-rail;desc=${rate(cacheStats.railSubHit, cacheStats.railSub)}pct`;
  const serverTiming = [...timings.map((t) => `${t.name};dur=${t.ms.toFixed(1)}`), cacheSummary].join(", ");
  const body = polygonOnly
    ? { polygon, minutes, origin: { lat, lon }, mode, polygonOnly: true }
    : { polygon, stops, minutes, origin: { lat, lon }, mode };
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
