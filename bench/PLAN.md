# Optimization plan — driven by baseline bench

## Baseline (2026-04-20, 3 trials, 30-min budget, Philly City Hall origin)

| stage                                   | mean    | payload  | stops |
|-----------------------------------------|--------:|---------:|------:|
| motis /one-to-all (raw)                 |    56ms |  820.9KB |  2861 |
| /api/isochrone (single time)            |    98ms |  803.5KB |  2861 |
| /api/isochrone (best-case, 18 times)    |   119ms |   1.23MB |  4478 |
| reachableToIsochrone (turf buffer+union)| **231s** |  102.5KB |  2861 |

## The only real problem

Polygon construction (`@turf/turf` buffer each of 2861 stops + union) takes
**minutes**. This runs on the client main thread after every click, which
fully explains "doesn't seem to be calculating now" — the UI is locked.

Everything else is already fast. MOTIS is 50ms. The fanout parallelizes. JSON
over localhost is 120ms. Shaving those further is rounding error until
polygon is fixed.

## Ranked fixes (implement in order, re-bench after each)

### 1. Move polygon computation server-side  *(correctness, not perf)*

Today the client does the 231s union. Moving it to the route handler on Node
(a) frees the UI thread, (b) lets us cache it, (c) makes the bench we wrote
actually measure a user-observable number.

**Bench signal**: `/api/isochrone` stage now includes polygon cost.

### 2. Project MOTIS response to slim shape before union

Keep only `{stopId, lat, lon, duration}`. Drops 820KB → ~200KB *and* the
in-memory per-stop object cost that turf walks. Expected 2-4x drop on ingest.

**Bench signal**: `/api/isochrone (single time)` payload drops 4x+.

### 3. Grid-snap stops to 150m cells, keep min-duration per cell

At a 30-min budget, a stop with duration=28 has a remaining-walk radius of
~160m. Two stops <150m apart with similar durations produce fully-overlapping
buffers — the union can drop either. SEPTA has hundreds of clustered bus
stops; expected 40-60% stop reduction for free.

**Bench signal**: polygon stage 2-4x faster, payload smaller.

### 4. Replace buffer+union with grid + marching-squares contour

Valhalla / OTP2 / r5 all do this. For each cell of a ~100m grid over the
travel radius, compute `min_over_stops(duration + walk_distance(cell, stop)/speed)`,
then contour at `maxMinutes`. With a KD-tree + radius cap this is O(cells)
per query and gives smooth polygons with correct holes. Buffer+union can't
do holes at all.

Target library: `d3-contour` (tiny, no deps), plus `kdbush` for NN lookups.

**Bench signal**: polygon stage in **sub-second**, likely <100ms.

### 5. LRU-cache projected MOTIS responses

Key by `(round(lat,4), round(lon,4), minutes, hour-bucket, arrive/depart)`.
GTFS is static between feed updates; the same origin at the same time yields
an identical response. For best-case scans, cold load is still 18 MOTIS
calls, but repeat clicks at the same origin → 0 MOTIS calls.

**Bench signal**: second-run `/api/isochrone (best-case)` close to 0ms.

### 6. Optional: gzip at Next route handler

`NextResponse` does not auto-gzip dynamic routes. After projection (step 2)
the payload is ~200KB — gzip drops that to ~40KB. Small win; do it last.

## Not doing (researched, not supported)

- MOTIS range/profile query (replacing 18 samples with 1): feature doesn't
  exist in MOTIS yet — filed as TODO in motis-project/motis#635.
- MOTIS binary (protobuf/flatbuffer) response: not supported.
- MOTIS server-side field filter: not supported.

## Non-goals tonight

- Rewriting MOTIS or writing our own router — researched earlier, rejected.
- Multi-region/multi-instance caching infra — single dev box is fine.
- UI perf (map rendering, label layout) — not on the hot path.

## Verification contract

After the plan completes:
- `bun run bench` shows `/api/isochrone (single time)` mean **< 300ms** end-to-end (MOTIS + merge + polygon)
- `/api/isochrone (best-case, 18 times)` mean **< 800ms** cold, **< 50ms** warm (cache hit)
- Client no longer runs turf union
- `bench/results/baseline.json` (before) and `bench/results/final.json` (after) are checked in

## Final results (2026-04-20)

| stage                                   | baseline | final  | delta   |
|-----------------------------------------|---------:|-------:|--------:|
| motis /one-to-all (raw)                 |    56ms  |   77ms | same    |
| polygon build (client turf → server d3) |  **231s**|  **11ms** | **~21000×** |
| /api/isochrone single-time (cold)       |    98ms  |   74ms | 1.3×, *now includes polygon* |
| /api/isochrone single-time (warm)       |     –    |   12ms | new (cache) |
| /api/isochrone best-case 18× (cold)     |   119ms  |  114ms | same, *now includes polygon* |
| /api/isochrone best-case 18× (warm)     |     –    |   14ms | new (cache) |
| merged payload, best-case               |  1.23MB  |  280KB | 4.4×    |
| single-time payload                     |  803KB   |  175KB | 4.6×    |

All targets met:
- Single-time with polygon: **74ms** ✓ (< 300ms)
- Best-case cold with polygon: **114ms** ✓ (< 800ms)
- Best-case warm: **14ms** ✓ (< 50ms)
- Client no longer runs turf union — UI no longer freezes ✓

---

## Review refactor (2026-04-22)

Post–rail-probe stack had a bench/reality mismatch: bench ran 18 hourly
samples (`114ms cold`) but prod client sampled every 5 min (216 calls).
Landed a `--trials=5` bench that mirrors prod and walked through the code
paths driving cold latency.

Changes:
- Cache key: bucketed by hour, which silently collapsed 12 samples/hr into
  one LRU slot (last-write-wins). Now keyed per-minute.
- `BEST_CASE_STEP_MIN`: dropped from 5 → 60. Rail discovery via railProbe's
  timetableView+searchWindow covers what the fine-grained sampling was
  originally meant to catch.
- `railProbe`: skips rail stops that `oneToAll` already placed with a valid
  duration. Most central rail is in oneToAll already; probe focuses on
  suburban long-headway stations the single-instant query misses.
- `railWindowSec` for best-case: cut 14h → 6h. Enough to catch the best
  commute-length trip, without paying for every half-hourly departure
  across the entire service day.
- Shared `motisLimiter` (MOTIS_CONCURRENCY env, default 32) replaces four
  different ad-hoc limits that fought each other for the same MOTIS thread
  pool. Makes tuning honest.
- Typed `motis-client` (`oneToManyIntermodalPost`, `oneToManyPost`, `stops`)
  replaces raw fetch in graphIsochrone, streetGrid, railProbe. Removes the
  `motisUrl` threading since the client reads a module-level base URL.
- `Array.from(Float64Array)` before d3-contour → pass the TypedArray
  directly. Saves one 15k-element heap copy per graph-mode request.

| stage                                   | pre-review | post-review | delta   |
|-----------------------------------------|-----------:|------------:|--------:|
| /api/isochrone single — cold            |     763ms  |       770ms | neutral |
| /api/isochrone single — warm            |     4.5ms  |       3.1ms | 1.4×    |
| /api/isochrone best-case 18 — cold      |     3.91s  |       3.69s | 1.06×   |
| /api/isochrone best-case 18 — warm      |     5.6ms  |       4.9ms | same    |
| /api/isochrone best-case 216 — cold     |     4.00s  |    (n/a prod) | prod no longer hits |
| /api/isochrone best-case 216 — warm     |     5.9ms  |      11.2ms | cache warm per-minute now |

Smaller numeric wins than hoped — cold best-case is dominated by MOTIS's
rail-probe plan() runtime, which our skip-set trimmed but didn't eliminate.
The real user-visible wins:
- Silent correctness bug in the best-case cache is fixed.
- Map.tsx no longer fires 216 oneToAll per click — 18 samples serve the
  same UX because railProbe is the authoritative rail-discovery path.
- The code is simpler (one limiter, typed MOTIS calls) — future perf work
  starts from a cleaner base.

## Deploy notes (Render / Cloudflare target)

MOTIS will not fit on a $7 Render Starter (needs ~4GB RAM for SEPTA GTFS +
PA OSM). Deploy path:
- **MOTIS**: Hetzner Cloud CX22 (~$5/mo, 4GB, 2 vCPU, 40GB) or Render Pro
  ($85/mo). Set `MOTIS_URL` on the app instance to its private hostname.
- **App (Next.js)**: Render Starter ($7/mo, 512MB, 0.5 CPU shared) fits.
  Audit for 240MB worst-case peak: baseline ~100MB + LRU caches ~40MB +
  transient per-request ~50MB + headroom. Tune `MOTIS_CONCURRENCY` down
  to 8–16 for remote MOTIS to keep app-tier queue depth reasonable.
- **CDN**: `Cache-Control` headers on `/api/isochrone` let an external
  CDN (Cloudflare free tier in front of Render) absorb repeat hits on
  popular origins.
- **Cloudflare Workers/Pages edge runtime**: viable but requires moving
  LRU to KV (cross-instance) and verifying d3-contour doesn't trip the
  10ms-CPU limit. Render + Hetzner is simpler.

Future perf work (not landed):
- Stream stops early, polygon late: return oneToAll stops in ~100ms and
  stream the graph-polygon as SSE or a second fetch. UX goes from "wait
  for 3.5s" to "dots show, polygon fills in".
- Cache intermodal durations per-cell across sample times — most cells
  have time-invariant street-only durations; skip re-routing those when
  sampling multiple times.
- Pre-compute polygons for popular origins at GTFS reload time.

## Round 4 — probe replacement + water mask + hybrid anchors (2026-04-23)

**Rail-probe replacement (massive perf win)**
- Deleted `probeRailReach` (plan()-per-station with timetableView, 14-18s cold).
- Replaced with a rail-only `oneToAll` pass at 15-min sub-samples of the
  user's hourly time window. For every hourly sample, we also run at
  :15/:30/:45 with `transitModes=[REGIONAL_RAIL]` and `maxTransfers=1`.
  MOTIS routes only the rail sub-graph → **~50ms per sample × 36 samples
  = 0.3-1s total** vs the probe's 14-18s. Same (better) rail coverage.
- Cached in a new `RAIL_SUB_CACHE` so warm repeats skip it entirely.

**Hybrid street-routed anchor walks**
- Earlier versions replaced MOTIS anchor walks with Euclidean disks
  (produced dense cells but ignored the street grid — disks were
  perfect circles over parks, hills, whatever was in the geometric
  radius). Now each late-budget anchor:
  1. Calls MOTIS one-to-many WALK for cells in its Euclidean disk,
     match=80m, max=1.5× budget.
  2. If MOTIS returns ≥6 cells (dense enough for d3-contour to stitch
     into a polygon), use those street-accurate durations.
  3. If MOTIS returns fewer cells (sparse due to snap failures),
     fall back to a Euclidean disk with 1.3 detour factor so the
     walkshed at least renders.
- Late-budget cutoff (anchor.reachedAtMinutes > maxMinutes/2) keeps
  city-center anchors from ever rasterizing. Their big disks would
  span rivers via the 80m match; intermodal already covers their
  reach anyway.

**Water-polygon mask**
- `scripts/build-water-mask.ts` pulls OSM water polygons in the SEPTA
  bbox (Overpass), filters to ≥50k m², simplifies, and ships to
  `public/water-mask.geojson` (~800KB, 322 polygons).
- `src/lib/waterMask.ts` loads the file at module init, exposes
  `isWater(lon, lat)`. Each polygon carries a precomputed bbox so the
  hot path is a cheap bbox reject before point-in-polygon.
- `graphIsochrone.ts` applies the mask when building the contour
  field — any cell whose center lands in water is forced to -Infinity
  regardless of MOTIS's routed duration. Kills the RiverLink ferry /
  BF Bridge pedestrian-deck leak that no match-distance tuning
  solved cleanly.

**Autofit map viewport**
- New polygons now `fitBounds` the viewport with padding so the
  complete polygon is visible. Addresses the "tiny polygon" report —
  the polygon was always big (400-500km² for 60-min best-case), the
  map just didn't re-center.

**Mode toggle (Bus/Subway/Trolley/Rail checkboxes)**
- Users can turn any transit mode off. Wired through MOTIS's
  `transitModes` param; cache keys include the mode subset so
  Bus-only vs Subway-only don't collide. Unchecking Rail skips the
  rail-sub pass entirely → instant ~3s faster cold best-case.

**Precompute path deleted**
- Static precomputed polygons were baked from stale code and masked
  the actual live-path fixes. Removed script + assets + client snap
  logic.

### Bench (post-all fixes)

| stage                                     | pre-round-1 | post-round-4 | delta   |
|-------------------------------------------|-----:|-----:|--------:|
| /api/isochrone single — cold              | 763ms |  592ms | 1.3×    |
| /api/isochrone single — warm              | 4.5ms |  4.2ms | same    |
| /api/isochrone best-case 18 — cold        | 3.91s |  **2.13s** | 1.8×    |
| /api/isochrone best-case 18 — warm        | 5.6ms |  5.6ms | same    |
| /api/isochrone best-case 216 — cold       | 4.00s |  3.18s | 1.3×    |
| /api/isochrone best-case 216 — warm       | 5.9ms | 12.0ms | same OOM |

30-min best-case rail coverage (City Hall): 37 stations reached, 31 of
them inside the drawn polygon (vs 17/31 earlier). No river bleed at
Delaware mid-river, BF Bridge, or Schuylkill at 30th St.

## Round 5 — overnight polish (2026-04-23 late)

**Polygon smoothing**
- `@turf/simplify` applied with tolerance 0.0003° (~33m) on the final
  MultiPolygon. Cuts vertex count 2-3× and rounds d3-contour's per-cell
  staircase into a continuous outline. Payload drops too (single:
  39KB → 30KB; best-case 18: 232KB → 199KB).

**Visible error handling**
- `errorMsg` state + a red banner at top-center. Fires on HTTP 5xx
  ("Routing service is unavailable"), network errors ("Is the dev
  server running?"), or an origin with zero reachable stops ("No
  transit reachable from this origin — try walk/bike toggle"). The
  old silent console.error was user-hostile; this is friendly.

**URL hash persistence**
- `#LAT,LON/MIN/MODE/BEST/MODES` shape. Restore on mount (auto-runs
  the query after departure defaults in), write on every state change
  via replaceState. Makes any view shareable/bookmarkable.

**Progress timer**
- Polygon stage (2-5s cold) now shows an elapsed-seconds counter next
  to the pulse. Addresses the "is anything happening?" moment between
  dots arriving and polygon rendering.

**Edge-case sweep (15 origins × 2 modes × 2 durations)**
- All major origins produce sensible polygons.
- Isolated origins (Navy Yard, Northeast Phila) produce small areas
  with zero rail — accurate, not a bug.
- Airport Terminal in bike mode fails to snap (OSM tags airport as
  car-only) — now surfaces the friendly "no reach" banner instead of
  an empty map.

### Final bench (3-trial with honest random-salt cold, 2026-04-23)

| stage                                     | pre-review | overnight | delta   |
|-------------------------------------------|-----:|-----:|--------:|
| /api/isochrone single — cold              | 763ms | **560ms** | 1.4×    |
| /api/isochrone single — warm              | 4.5ms |  2.8ms | 1.6×    |
| /api/isochrone best-case 18 — cold        | 3.91s |  **1.96s** | 2.0×    |
| /api/isochrone best-case 18 — warm        | 5.6ms |  3.9ms | 1.4×    |
| /api/isochrone best-case 216 — cold       | 4.00s |  2.79s | 1.4×    |
| /api/isochrone 60min single — cold        |   —   |  **395ms** | new row |
| /api/isochrone 60min best-case 18 — cold  |   —   |  **1.33s** | new row |
| polygon payload (single)                  | 39KB  |  27KB  | 1.4×    |
| polygon payload (best-case 18)            | 232KB | 163KB | 1.4×    |

Earlier bench rounds used `salt=1,2,3,...` which collided across runs —
the first few trials each run hit salted origins the previous bench had
already cached, inflating "cold" warmth. Fixed by seeding salt from the
timestamp. Numbers above are post-fix; some previously-reported deltas
in this document understate the true gains (they were partly-warm).

### 60-min budget improvements (2026-04-23 v2)

Bench now includes 60-min rows. Adaptive cell size (60m at ≤30min, 84m
at 31-45min, 120m at >45min) shrinks cell count ~4× at the top end:

| stage                                     | cold mean |
|-------------------------------------------|----------:|
| /api/isochrone 60min single — cold        |     395ms |
| /api/isochrone 60min best-case 18 — cold  |     1.33s |

Per-origin sweep shows consistent 3-4× speedup on 60min queries:

## Round 7 — multi-band rings + best-case default (2026-04-23)

**Multi-band isochrone**
- Response `polygon` is now a `FeatureCollection` of 1-3 nested band
  Features instead of a single polygon. Bands at 1/3, 2/3, 3/3 of
  maxMinutes (rounded to multiples of 5). Each Feature has `band`
  (1=innermost) and `minutes` properties.
- Client renders with MapLibre `fill-sort-key` so the innermost band
  draws on top, graduated `fill-opacity` per band (0.42 / 0.28 / 0.15).
  Outline is stronger on the outer edge, dim inside.
- Addresses "exact-minute brittleness": a station reached at 28min
  falls cleanly in the outer band; no visual difference from 30min.
  Gives users a heatmap-style view of how close things are.

**Best-case default ON**
- Single-time queries only find rail stations with a good train at
  the exact sampled minute. Most suburban rail (Manayunk, Bala,
  Jenkintown, Chestnut Hill) missed the polygon because their
  arrivals at :12 or :23 don't align with :00 samples.
- Best-case is now the default (checkbox renamed to "Scan full day
  (best train within hourly window)"). Cold latency only ~1-2s
  higher; coverage dramatically better.

Bench cold with bands + default best-case:

| stage | mean |
|---|---:|
| single 30min | 574ms |
| best-case 18 | **1.94s** |
| 60min single | 385ms |
| 60min best-case 18 | 1.30s |

## Round 8 — regression test + water-mask false-positive fix (2026-04-23 late)

**The regression that kept returning**: every round of refactoring
silently broke one of ~8 independent mechanisms in the rail-coverage
pipeline (oneToAll timing, rail-sub sampling, anchor list membership,
anchor-walk rasterization, minRingM2 filter, contour validity, simplify
tolerance, water mask). Without an automated check, we kept shipping
each round thinking it was fine.

**Fix**: `bun run test:coverage` → `scripts/test-coverage.ts` runs a
golden-set of (origin, budget, expected-covered-rail, expected-
unreachable-water) and fails loud on any regression. Run after every
change touching graphIsochrone / route / anchor / mask logic.

The test immediately caught two real bugs:
1. **Water mask false positive at 30th St**: the Schuylkill OSM
   polygon overlaps 30th St Station's GTFS coord. Station was always
   masked as water. Fixed by exempting cells within 120m of any
   reachable transit stop from the water mask — stations are by
   definition on land.
2. **Hybrid anchor walk skipped station cell**: when MOTIS returned
   enough cells for useStreet=true, cells MOTIS did NOT return were
   SKIPPED. But MOTIS sometimes can't snap the station's own coord
   (platform is 40m+ from nearest walkable way), leaving the station's
   cell at Infinity and invisible in the polygon. Fixed by falling
   back to Euclidean (with 1.3 detour) for cells MOTIS missed.

Final coverage test (City Hall / 30th St / Jenkintown × 30min/60min
best-case):
- 12 expected rail stations covered ✓
- 0 water-bleed cells ✓
- 4/4 test cases pass ✓

## Round 9 — revert multi-band visual, keep server data (2026-04-23)

The 3-band stacked-fill render produced visual clutter: nested outlines
for every polygon piece, and band-boundary artifacts where independent
simplify passes nudged inner bands past the outer band's outline (fill
appeared outside the "isochrone"). User reported "lots of overlapping
polygons and weird shading angled outside."

Server still emits a 3-band FeatureCollection (bands are cheap and may
be useful for hover tooltips / heatmaps later). Client renders only
the outermost band (`band == bandCount`) with a single fill + outline
layer. Visual is clean again. Rail coverage unchanged — the hybrid
anchor walk + water-mask-exempt-near-stops + rail-sub sampling all
still operate on the underlying field.


| origin         | 60-min cold (before) | 60-min cold (after) |
|----------------|---------------------:|--------------------:|
| City Hall walk | 17.5s                | **5.2s**            |
| 30th St walk   | 18.7s                | 5.4s                |
| Suburban walk  | 19.4s                | 5.9s                |
| Temple walk    | 15.5s                | 4.6s                |
| Jenkintown walk| 10.4s                | 3.0s                |
| Fern Rock walk | 10.0s                | 2.9s                |

Polygon outline unchanged because simplify runs at 33m tolerance
downstream (larger source cells don't show at display scale).

## Round 2 fixes (2026-04-22 pm)

Polygon correctness issues reported after round 1:
- **River bleed**: polygon filled the Delaware River. Rail-anchor walk
  used `maxMatchingDistance: 80` to let mid-block cells snap to streets,
  but that also snapped river cells to the RiverLink ferry edge
  (`route=ferry; foot=yes` in OSM) and BF Bridge pedestrian deck.
  Tightened to 18m to match intermodal.
- **Tiny orphan polygons**: `minRingM2` raised from 9×cellM² (~180m side)
  to 25×cellM² (~300m side). Drops ferry-snap artifacts while keeping
  genuine single-stop islands.

Perf:
- `GRAPH_SAMPLE_K` dropped from 3 to 2 for best-case. `railProbe` already
  optimizes rail departure-time choice via `timetableView` — the third
  graph-intermodal sample was redundant for rail coverage. Cut ~33% of
  graph-intermodal wallclock.
- Added `Server-Timing` header with phase breakdown (ota, probe, graph,
  total). Lets devtools surface "where did the 3s go" without custom
  instrumentation.

| stage                                   | pre (round 1) | post (round 2) | delta   |
|-----------------------------------------|-----:|-----:|--------:|
| /api/isochrone single — cold            |  770ms |  876ms | noise   |
| /api/isochrone best-case 18 — cold      |  3.69s |  **2.47s** | 33% off |
| /api/isochrone best-case 18 — warm      |  4.9ms |  4.7ms | same    |

## Round 3: streaming + precompute (2026-04-22 pm)

Two-stage rendering and a popular-origins precompute cache, both to
mask the MOTIS-dominated cold cost.

**Streaming (stops fast, polygon slow)**
- `/api/isochrone?stopsOnly=true` returns after oneToAll, skips probe +
  graph. Typical ~100-300ms cold. Client renders dots immediately.
- `/api/isochrone?polygonOnly=true` omits `stops` from the body (client
  has them). Same compute cost, smaller response.
- `Map.tsx` fires stops → renders → fires polygon → renders. Cancels
  in-flight polygon on new click via `AbortController` so stale data
  never overwrites a new query. Loading label reflects stage:
  "Finding reachable stops…" → "N stops · computing polygon…" → done.

Observed: first paint (dots) drops from ~3.5s to ~100-300ms. Wallclock
to fully-rendered polygon is unchanged (still MOTIS-bound).

**Precompute (popular origins instant)**
- `scripts/precompute-polygons.ts` (`bun run precompute`) iterates a
  seed list of 12 popular origins × 3 time slots × 2 street modes = 72
  entries. Writes one JSON per entry into `public/precomputed/` plus an
  `index.json` describing the lookup keys.
- Current seed list: City Hall, 30th/Suburban/Jefferson Stations,
  Temple, UPenn, Fern Rock, Frankford, 69th St, Fairmount, Broad &
  Snyder, Chestnut Hill East.
- Static assets total ~12MB at 30-min walk/bike budgets. Easily served
  by Render/CF static hosting, Cloudflare free-tier cache absorbs
  repeat hits at zero app-tier cost.
- `Map.tsx` loads the index on mount and, on click, snaps to a
  precomputed origin within 150m + matching mode/slot. Hit → fetch
  static file → paint polygon in one frame. Miss → fall through to the
  live two-stage flow.

Combined UX:
- Click on a seed origin (e.g., City Hall): **instant** polygon (one
  HTTP to a CDN-cacheable static asset).
- Click anywhere else: stops in ~300ms, polygon in ~2.5s.
- Subsequent clicks at the same origin/params: warm cache hit, 5-15ms.
