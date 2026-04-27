# Deploy: Cloudflare Workers + Containers

Single-image deploy to Cloudflare Containers, scale-to-zero. The MOTIS
dataset is baked into the Docker image so cold starts skip the runtime
fetch (CF gives every cold start an ephemeral disk).

**Recurring cost:** ~$5.32/mo on a hobby usage profile (Workers Paid
$5/mo + ~$0.32 in metered memory above the free tier). Always-on is
~$11.59/mo if you'd rather skip the cold-start UX.

**One-time prep on your laptop (~10 min):**

1. Install wrangler and authenticate:
   ```bash
   bun install                       # gets wrangler + @cloudflare/containers
   bunx wrangler login               # opens browser, OAuth flow
   ```

2. Build the MOTIS graph and pack it into the tarball that the Dockerfile bakes in. This step needs ~6 GB free RAM (don't run on a tiny VM):
   ```bash
   # Refresh source data (skip if data/ already populated):
   mkdir -p data
   curl -L -o data/septa-gtfs.zip https://www3.septa.org/developer/gtfs_public.zip
   unzip -p data/septa-gtfs.zip google_bus.zip > data/google_bus.zip
   unzip -p data/septa-gtfs.zip google_rail.zip > data/google_rail.zip
   curl -L -o data/pennsylvania-latest.osm.pbf \
     https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf

   # Clip OSM to the SEPTA region (~84 MB instead of 333):
   osmium extract --bbox=-76.0,39.55,-74.65,40.45 \
     data/pennsylvania-latest.osm.pbf -o data/septa-region.osm.pbf

   # Build the MOTIS graph:
   docker compose run --rm -w /workspace motis /motis import

   # Patch onetomany_max_many in the baked config (MOTIS rebakes a copy at import):
   sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' \
     data/data/config.yml

   # Pack into the tarball that the Dockerfile bakes in:
   bun run pack:motis
   ls -lh dist/motis-dataset.tar.gz   # ~120 MB
   ```

3. Deploy:
   ```bash
   bun run deploy
   # equivalent to: bunx wrangler deploy
   ```

   First deploy takes ~5 min: wrangler builds the Dockerfile (Next.js
   compile + dataset bake), pushes the image to CF's registry, and
   provisions the Worker + Container binding. You'll see the deploy URL
   at the end (`https://transit-isochrones.<your-account>.workers.dev`).

4. Open the URL. The page loads, the warm-up banner shows for ~25 s
   while MOTIS mmaps the graph, then disappears. Click around.

That's it. No DNS, no TLS, no ssh, no cron job.

## Custom domain

If you want `transit-isochrones.your-domain.com` instead of the
`workers.dev` URL:

1. Add your domain to Cloudflare (Sites → Add Site).
2. Uncomment the `routes` block in `wrangler.jsonc` and set both fields.
3. `bun run deploy` again.

CF auto-provisions the cert. You don't see Let's Encrypt anywhere in
this flow.

## Recurring tasks

### Deploy a code change

```bash
bun run deploy
```

Wrangler diffs the image; if only Next.js source changed (no Dockerfile
change), the Next.js layer rebuilds and the dataset layer is reused
from cache. ~1–2 min.

### Refresh the MOTIS dataset (new GTFS, etc.)

```bash
# Re-import + re-pack:
docker compose run --rm -w /workspace motis /motis import
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' data/data/config.yml
bun run pack:motis
# Re-deploy bakes the new tarball into the image:
bun run deploy
```

### Tail logs

```bash
bunx wrangler tail
```

Streams stdout/stderr from the running container in real time.

### Inspect / scale instance type

`wrangler.jsonc` → `containers[0].instance_type`:
- `dev` (256 MB, 1/16 vCPU) — too small for MOTIS.
- `basic` (1 GB, 1/4 vCPU) — current default; fits MOTIS + app comfortably.
- `standard` (4 GB, 1/2 vCPU) — for tighter polygon latency under load.

Edit and `bun run deploy`.

## How the warm-up flow works

1. CF Container is asleep (no requests for `sleepAfter` = 5 min).
2. User visits the page → Worker forwards to the container → container starts.
3. Next.js is ready in ~3 s and serves the HTML.
4. The page mounts and immediately fires `/api/health`. That request is
   what wakes MOTIS — the response will be 503 until MOTIS finishes
   mmap'ing the graph (~25 s after process start).
5. The Map UI shows an amber "Warming up — first query ready in ~30 s"
   banner. Polls `/api/health` every 2 s.
6. As soon as MOTIS reports ready, banner clears. The user has been
   exploring the UI in the meantime, so when they click Run, MOTIS is hot.

Net cold-start UX: ~3 s of "blank page", then HTML loads, then ~25 s
with the banner — but the user can interact with the slider, mode
toggles, etc. during that window. By the time they pin an origin and
hit Run, the polygon comes back at normal latency.

## Troubleshooting

**`wrangler deploy` fails on `COPY dist/motis-dataset.tar.gz`.** You
forgot `bun run pack:motis`. The Dockerfile requires the file to exist.

**Container won't start, logs say `motis import` errors.** The dataset
in the image is corrupt or built against a different MOTIS version.
Re-import locally and re-deploy.

**`/api/health` keeps 503'ing past 60 s.** Container ran out of
memory — `basic` (1 GB) might be too small under load. Bump
`instance_type` to `standard` and redeploy.

**Cold-start banner shows on every visit, even right after one.** Your
`sleepAfter` is too short for typical session gaps. Bump from `5m` to
`15m` or `1h` in `worker/index.ts`.
