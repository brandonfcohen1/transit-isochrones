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

## Deploy

Cloudflare Workers + Containers, scale-to-zero. ~$5/mo at hobby usage.
End-to-end instructions in [`deploy/README.md`](deploy/README.md). The
short version:

```bash
bunx wrangler login          # one-time
bun run pack:motis           # builds dist/motis-dataset.tar.gz from data/data
bun run deploy               # = wrangler deploy
```

Wrangler builds the Dockerfile (which bakes the dataset into the image
so cold starts skip the runtime fetch), pushes to CF's container
registry, and hooks up the Worker that fronts the container. First
deploy lands at `https://transit-isochrones.<your-account>.workers.dev`.

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

Returns 503 when MOTIS isn't reachable. The client polls this on mount
to drive the warm-up banner during a CF Container cold start.

## Scripts

```bash
bun run dev               # Next dev server
bun run build             # Next production build
bun run build:routes      # Rebuild public/septa-routes.geojson from GTFS
bun run pack:motis        # Pack data/data → dist/motis-dataset.tar.gz
bun run deploy            # wrangler deploy (Cloudflare Containers)
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
