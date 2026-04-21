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
