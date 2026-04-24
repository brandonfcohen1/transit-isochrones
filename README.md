# SEPTA Isochrone

See how far you can go on SEPTA transit from any origin in N minutes.

- **Engine**: [MOTIS](https://github.com/motis-project/motis) for transit + street routing, loaded with SEPTA GTFS + a Pennsylvania OSM extract.
- **App**: Next.js 16 BFF wrapping MOTIS. Server-side polygon construction (d3-contour + turf cleanup); map client uses MapLibre.
- **Two-stage UI**: stops arrive in ~100-300 ms and render as colored dots; polygon lands a few seconds later.
- **Coverage**: Philadelphia and surrounding counties. Bounded by a coverage bbox at the API layer.

## Prereqs

- [Docker](https://www.docker.com/)
- ~5 GB free disk + ~4 GB RAM for the MOTIS graph
- (Dev only) [Bun](https://bun.sh/)

## Data setup (needed for both deploy paths)

```bash
mkdir -p data
# SEPTA GTFS (bus + rail feeds ship inside one zip)
curl -L -o data/septa-gtfs.zip https://www3.septa.org/developer/gtfs_public.zip
unzip -p data/septa-gtfs.zip google_bus.zip > data/google_bus.zip
unzip -p data/septa-gtfs.zip google_rail.zip > data/google_rail.zip
# Pennsylvania OSM extract
curl -L -o data/pennsylvania-latest.osm.pbf https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf
# config.yml is already checked in under data/ with SEPTA-tuned settings.
```

## Deploy: single container (production)

Builds MOTIS + the Next.js app into one image running under supervisord. Good for a $5–8/mo VPS.

```bash
# 1. Build the image
docker build -t septa-iso .

# 2. One-time MOTIS graph build (uses the same image, runs MOTIS import
#    then exits). Takes several minutes. Output ends up in ./data/data/.
docker run --rm -v $(pwd)/data:/workspace -w /workspace septa-iso /motis import

# 3. Run
docker run -d --name septa-iso --restart unless-stopped \
  -v $(pwd)/data:/workspace \
  -p 3000:3000 \
  septa-iso
```

Exposes `:3000` (Next.js). MOTIS runs inside the container on `127.0.0.1:8080` and isn't published. First request after cold boot waits ~30 s for MOTIS to load its graph; after that, normal latencies.

Docker healthcheck probes `/api/health` — platforms like Fly.io or Render will respect it.

## Dev: multi-service compose

If you want fast HMR on the Next side while MOTIS runs separately:

```bash
bun install
docker compose up motis    # leave running
bun run dev                # Next dev server on :3000
```

Open http://localhost:3000.

## Health probe

`GET /api/health` checks MOTIS reachability and reports in-process cache counters:

```json
{ "ok": true, "motis": { "ok": true, "status": 404 }, "caches": { ... }, "uptimeSec": 123, "probeMs": 18 }
```

Returns 503 when MOTIS isn't reachable. Suitable for Render/Kubernetes readiness probes.

## Scripts

```bash
bun run dev               # Next dev server
bun run build             # Next production build
bun run build:routes      # Rebuild public/septa-routes.geojson from GTFS
bun run bench             # Isochrone latency bench (see bench/PLAN.md)
bun run test:coverage     # Golden-set rail-coverage regression test
```

## Environment

| var | default | notes |
|---|---|---|
| `MOTIS_URL` | `http://localhost:8080` | Server-side. Don't prefix with `NEXT_PUBLIC_`; keeps the URL out of the browser bundle. |
| `MOTIS_CONCURRENCY` | `32` | Global in-flight cap for MOTIS calls. Drop to 8–16 if MOTIS runs on a smaller remote box. |
| `MOTIS_TIMEOUT_MS` | `20000` | Per-call timeout on every MOTIS request. |
| `NEXT_PUBLIC_MAPTILER_KEY` | — | Optional. Without it, falls back to `demotiles.maplibre.org` (visibly low-fi). |

## Deploy notes

MOTIS won't fit on a $7 Render Starter (needs ~4 GB for SEPTA GTFS + PA OSM). Split the deploy:
- **MOTIS**: Hetzner CX22 (~$5/mo, 4 GB, 2 vCPU) or Render Pro (~$85/mo). Set `MOTIS_URL` on the app to its private hostname.
- **App**: Render Starter (512 MB) fits. LRU caches + transient per-request allocations sit around 150–200 MB peak.
- **CDN**: `Cache-Control: public, max-age=60, s-maxage=300` on `/api/isochrone` lets a CDN (Cloudflare free tier works) absorb repeat hits.

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
  test-coverage.ts          # golden-set rail-coverage regression test
data/                       # gitignored — MOTIS inputs and graph
```
