# SEPTA Isochrone

See how far you can go on SEPTA transit from any origin in N minutes.

- **Engine**: [MOTIS](https://github.com/motis-project/motis) for transit + street routing, loaded with SEPTA GTFS + a Pennsylvania OSM extract.
- **App**: Next.js 16 BFF wrapping MOTIS. Server-side polygon construction (d3-contour + turf cleanup); map client uses MapLibre.
- **Two-stage UI**: stops arrive in ~100-300 ms and render as colored dots; polygon lands a few seconds later.
- **Coverage**: 5-county SEPTA region + Wilmington/Newark DE + Trenton NJ rail termini.
- **Status**: runs locally; cloud deploy is on hold. See [Cloud deployment status](#cloud-deployment-status) below.

## Run locally

The app runs as two services: **MOTIS** (transit/street routing engine, in Docker) and the **Next.js** app (Bun on your host). MOTIS holds the routing graph in memory and answers route queries; Next.js wraps it with a UI and the polygon-building logic.

### 1. Install prerequisites

You need Docker, Bun, and Git. macOS instructions below; Linux equivalents are obvious; Windows works with WSL2.

```bash
# macOS via Homebrew (https://brew.sh — install if you haven't):
brew install --cask docker
brew install bun git osmium-tool

# Or grab Docker Desktop manually: https://www.docker.com/products/docker-desktop/
# Bun installer: https://bun.sh

# Verify:
docker --version          # ≥ 24
bun --version             # ≥ 1.2
osmium --version          # any
```

Open Docker Desktop once so the daemon is running. Bump its memory allocation to **at least 6 GB** (Settings → Resources → Memory) — `motis import` peaks around 4–8 GB and a 4 GB default Docker can OOM. The app itself only uses ~150 MB at runtime.

### 2. Clone and install

```bash
git clone https://github.com/brandonfcohen1/transit-isochrones
cd transit-isochrones
bun install
```

### 3. Download the source data

SEPTA GTFS + a Pennsylvania OSM extract. ~700 MB total download.

```bash
mkdir -p data
# SEPTA GTFS (bus + rail feeds ship inside one zip)
curl -L -o data/septa-gtfs.zip https://www3.septa.org/developer/gtfs_public.zip
unzip -p data/septa-gtfs.zip google_bus.zip > data/google_bus.zip
unzip -p data/septa-gtfs.zip google_rail.zip > data/google_rail.zip
# Pennsylvania OSM extract from Geofabrik
curl -L -o data/pennsylvania-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf
```

### 4. Clip OSM to the SEPTA region

Pennsylvania is huge; we only need the 5-county region + nearby rail termini. Clipping cuts the OSM file 75%, the imported graph 50%, MOTIS RAM 65%, and import time ~80%.

```bash
osmium extract --bbox=-76.0,39.55,-74.65,40.45 \
  data/pennsylvania-latest.osm.pbf \
  -o data/septa-region.osm.pbf
```

The bbox is hard-coded into `data/config.yml` and the API coverage check; if you change it, update both.

### 5. Build the MOTIS graph (one-time, ~3–5 min)

```bash
docker compose run --rm -w /workspace motis /motis import
```

`motis import` reads `data/config.yml`, ingests GTFS + OSM, and writes a binary graph into `data/data/`. Peak RAM ~6 GB during this step. After it finishes, you'll have a `data/data/` directory of ~500 MB.

MOTIS rewrites the config into `data/data/config.yml` during import. One knob has to be patched — without this the precise-streets isochrone batches into ~10 calls instead of 1:

```bash
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' data/data/config.yml
# Linux: drop the '' after -i
```

(Re-run after every fresh import — the project memory file `project_motis_baked_config.md` documents this.)

### 6. Build the rail-line offsets table

Used by `/api/isochrone` to back-fill rail reach where MOTIS's one-to-all under-reports. One-time per GTFS feed.

```bash
bun run build:rail-offsets
```

Writes `src/lib/rail-line-offsets.json`.

### 7. Start MOTIS, then the dev server

```bash
docker compose up -d motis    # background; takes ~30 s to load the graph

# Wait for MOTIS to be ready (returns HTTP 404 when up — the root has no handler):
until curl -s http://127.0.0.1:8080/ -o /dev/null; do sleep 2; done

bun run dev                   # Next dev server, hot-reloading
```

Open <http://localhost:3000>. Click anywhere on the map to stage an origin, click **Run** (or press Enter) to compute the isochrone. Click any reachable stop or anywhere inside the polygon for turn-by-turn directions.

### Optional: prettier basemap

The default basemap is `demotiles.maplibre.org`, which is a low-fi fallback. For Carto Positron tiles, get a free MapTiler API key (<https://www.maptiler.com/cloud/>) and create `.env.local` (already in `.gitignore`):

```
NEXT_PUBLIC_MAPTILER_KEY=your_key_here
```

Restart `bun run dev` to pick it up.

### Refreshing GTFS

SEPTA pushes a new GTFS feed every few weeks. To pick up changes:

```bash
curl -L -o data/septa-gtfs.zip https://www3.septa.org/developer/gtfs_public.zip
unzip -p data/septa-gtfs.zip google_bus.zip > data/google_bus.zip
unzip -p data/septa-gtfs.zip google_rail.zip > data/google_rail.zip
docker compose down motis
rm -rf data/data
docker compose run --rm -w /workspace motis /motis import
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' data/data/config.yml
bun run build:rail-offsets
docker compose up -d motis
```

## Cloud deployment status

**Currently on hold.** The repo has a working Cloudflare Workers + Containers deploy path (`deploy/`, `wrangler.jsonc`, `worker/`) but real-world performance on the affordable instance tiers isn't acceptable. Summary of what we hit:

- **CPU is the binding constraint.** An isochrone polygon needs ~30 parallel MOTIS one-to-many calls (the "graph" phase). On a developer laptop with 8–11 cores those parallelize naturally and finish in ~2 s. On Cloudflare Containers' `standard-2` tier (1 vCPU) they queue against a single core and take ~50 s. Memory and network aren't the bottleneck — pure single-core throughput is.

- **No realistic instance tier under ~$10/mo gives sub-30 s cold queries.** The CF Containers ladder: `standard-2` (1 vCPU, $8/mo) ≈ 70 s, `standard-3` (2 vCPU, $9/mo) ≈ 35 s, `standard-4` (4 vCPU, $11/mo) ≈ 17 s. Hetzner CCX13 (2 dedicated cores, $8.50/mo, EU) is roughly comparable to CF `standard-3`. To match local feel you need ~4 cores, which puts the floor around $11–16/mo.

- **The fix is caching, not bigger machines.** Isochrones are deterministic in `(origin, mode, minutes, modes-mask, day-bucket)`, so most user sessions repeat the same cache key on every slider tick or zoom. The in-process LRUs already make warm hits ~50 ms, but they die when the container scales to zero. Pushing the cache out to Cloudflare KV or R2 — keyed on a quantized origin grid — would let a tiny container handle most traffic instantly. A nightly cron pre-warming common origins would handle most first-clicks too. Roughly 30 lines of code plus a cron worker; not yet shipped.

- **The container's MOTIS process can crash under burst load.** The first per-stop plan() implementation overran MOTIS's internal queue on `standard-1` and the process died. We added a respawn loop in `scripts/start.sh` (commit `5c83bb0`) so future crashes don't leave the container half-broken, and reverted the per-stop fix in favor of a lighter per-line-terminus version (`eee429f`). Both are on `main`.

- **MOTIS's one-to-all under-reports rail reach** on AIR / Chestnut Hill East / Fox Chase / Trenton tail by 5–12 min — RAPTOR rounds don't extend a single vehicle's reach across all its remaining stops. Our `/api/isochrone` runs a per-line-terminus `plan()` and back-fills upstream stops via GTFS offsets to correct this. Documented in `src/app/api/isochrone/route.ts` and the `project_rail_reach_plan_override.md` memory file.

If you want to revive the cloud deploy: pick up the caching work first, *then* worry about instance size. With KV-backed warm-cache hits, even `standard-1` ($7/mo) is enough for most traffic. The deploy guide in `deploy/README.md` is current and works end-to-end — the only reason it's not running is that the cold-query latency wasn't worth shipping yet.

## Health probe

`GET /api/health` checks MOTIS reachability and reports in-process cache counters:

```json
{ "ok": true, "motis": { "ok": true, "status": 404 }, "caches": { ... }, "uptimeSec": 123, "probeMs": 18 }
```

Returns 503 when MOTIS isn't reachable. The client polls this on mount
to drive the warm-up banner during a CF Container cold start.

## Scripts

```bash
bun run dev               # Next dev server
bun run build             # Next production build
bun run build:routes      # Rebuild public/septa-routes.geojson from GTFS
bun run build:rail-offsets # Rebuild src/lib/rail-line-offsets.json from GTFS
bun run pack:motis        # Pack data/data → dist/motis-dataset.tar.gz (cloud only)
bun run deploy            # wrangler deploy (cloud — see status above)
bun run bench             # Isochrone latency bench (see bench/PLAN.md)
bun run test:coverage     # Golden-set rail-coverage regression test
```

## Environment

| var | default | notes |
|---|---|---|
| `MOTIS_URL` | `http://localhost:8080` | Server-side. Don't prefix with `NEXT_PUBLIC_`; keeps the URL out of the browser bundle. |
| `MOTIS_CONCURRENCY` | `32` | Global in-flight cap for MOTIS calls. Drop to 8–16 on the `basic` CF instance type to flatten peak RAM. |
| `MOTIS_TIMEOUT_MS` | `20000` | Per-call timeout on every MOTIS request. |
| `NEXT_PUBLIC_MAPTILER_KEY` | — | Optional. Without it, falls back to `demotiles.maplibre.org` (visibly low-fi). |

## Notable design decisions

See `bench/PLAN.md` for the iteration log. Highlights:
- Polygon construction is server-side — the original client-side `turf.buffer`-per-stop ran 231 s on dense origins. The grid + marching-squares pass is ~5 ms.
- Graph-mode (`method=graph`, default) polls MOTIS's `one-to-many-intermodal` on a cell grid so the polygon respects rivers, rail yards, and the actual walkable/bikeable graph.
- Regional Rail reach is filled in via a hybrid: hourly `one-to-all` samples + 15-min rail-only sub-samples catch off-clock departures, and a per-anchor street-routed walk disk gives each far station a realistic walkshed.
- Four LRU caches (oneToAll, street-grid, graph-polygon, rail-sub) make warm repeats < 15 ms.
- Client state lives in the URL hash (`#LAT,LON/MIN/MODE/BEST/MODES`) so refresh and share-links restore the view.

## Project structure

```
src/
  app/
    api/
      isochrone/route.ts    # main isochrone endpoint
      plan/route.ts         # itinerary endpoint for stop-click routes
    layout.tsx, page.tsx
  components/
    Map.tsx                 # MapLibre shell + UI
  lib/
    graphIsochrone.ts       # polygon builder (grid → contour → cleanup)
    motis.ts                # typed MOTIS client + timeout helper
    motisLimiter.ts         # global concurrency cap for MOTIS
    cache.ts                # small LRU + process-wide cache counters
    rateLimit.ts            # per-IP token bucket
    types.ts                # shared API contract types (SlimStop, etc.)
    polyline.ts             # Google polyline decoder (for plan legs)
bench/
  run.ts                    # latency bench harness
  results/                  # persisted bench JSON for diffing runs
scripts/
  build-routes-geojson.ts   # builds public/septa-routes.geojson from GTFS
  pack-motis-dataset.ts     # tars+gzips data/data → dist/motis-dataset.tar.gz
  test-coverage.ts          # golden-set rail-coverage regression test
worker/
  index.ts                  # CF Worker entry; forwards to the named Container
deploy/
  README.md                 # CF Containers deploy guide
wrangler.jsonc              # CF Worker + Container config
data/                       # mostly gitignored — MOTIS inputs and graph
data/config.yml             # tracked; the input MOTIS reads at import
```
