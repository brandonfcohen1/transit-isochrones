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

Builds MOTIS + the Next.js app into one image running under supervisord. Two ways to provision the MOTIS dataset:

### (a) Bind-mount, build the graph on the deploy box

For boxes with ≥4 GB free RAM during import. The graph build takes 5–15 min and is a one-time cost.

```bash
docker build -t septa-iso .
docker run --rm -v $(pwd)/data:/workspace -w /workspace septa-iso /motis import
docker run -d --name septa-iso --restart unless-stopped \
  -v $(pwd)/data:/workspace -p 3000:3000 \
  septa-iso
```

### (b) Pre-built dataset, fetched on boot

Best for small VMs (Hetzner CX22 at $4/mo, etc.) that can't run `motis import` themselves — the import peaks at 4–8 GB RAM. The operator imports on a beefy machine once, packs the dataset into a tarball, uploads to object storage, and points the deploy at it.

```bash
# Locally (one-time, on a machine with ≥8 GB RAM):
docker run --rm -v $(pwd)/data:/workspace -w /workspace septa-iso /motis import
bun run pack:motis                                 # → dist/motis-dataset.tar.gz (~360 MB)
rclone copy dist/motis-dataset.tar.gz r2:bucket/   # or aws s3 cp …

# On the deploy box:
docker run -d --name septa-iso --restart unless-stopped \
  -v septa-data:/workspace \
  -e MOTIS_DATASET_URL=https://your-bucket.r2.dev/motis-dataset.tar.gz \
  -p 3000:3000 \
  septa-iso
```

The container's `motis-bootstrap.sh` fetches and extracts on first start (~60–90 s for 360 MB). A `.bootstrapped` marker on the volume prevents re-fetch on restarts. Re-import locally + re-upload + delete the marker (or wipe the volume) when you want to refresh GTFS.

Either way, `:3000` exposes Next.js; MOTIS sits on `127.0.0.1:8080` inside the container. First request after cold boot waits ~30 s for MOTIS to load its graph. Docker healthcheck probes `/api/health`.

For HTTPS on a VPS, front this with Caddy or Traefik. A two-line Caddyfile gets you Let's Encrypt automatically:
```
your-domain.com {
  reverse_proxy localhost:3000
}
```

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

- **Single-box** (Hetzner CX22, $4/mo, 4 GB, 2 vCPU): use deploy path (b) above. The 4–8 GB RAM `motis import` peak doesn't run on the box; you ship a pre-built tarball. MOTIS server steady-state sits at ~1.5 GB resident, leaving ~2 GB for Next.js + OS.
- **Two-box** (any tiny app host + a beefier MOTIS box): set `MOTIS_URL` on the app to MOTIS's private hostname. Lets a 512 MB app dyno on Render Starter front a separate MOTIS box.
- **CDN**: `Cache-Control: public, max-age=60, s-maxage=300` on `/api/isochrone` lets a CDN (Cloudflare free tier) absorb repeat hits.

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
