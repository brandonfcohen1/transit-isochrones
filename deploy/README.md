# Deploy: Cloudflare Workers + Containers

Single-image scale-to-zero deploy. The MOTIS dataset is baked into the
Docker image at build time, so cold starts skip any runtime fetch — CF
gives every cold start an ephemeral disk, but the dataset is already
there in the image layer.

**Recurring cost:** ~$5.32/mo at hobby usage profile (Workers Paid base
$5/mo + ~$0.32 in metered memory above the free tier).

---

## One-time setup (~10 min)

### 1. Install + log in

```bash
cd ~/Documents/dev/septa-isochrone
bun install                       # gets wrangler + @cloudflare/containers
bunx wrangler login               # opens browser; OAuth flow
```

`wrangler login` writes credentials to `~/.config/.wrangler/config/default.toml`.
You only do this once per machine.

### 2. Create `.env.production` (one-time)

Required: the Dockerfile `COPY`s this file into the Next.js build, even
if it's empty. Build-time public env vars baked into the client bundle
go here — most usefully `NEXT_PUBLIC_MAPTILER_KEY` for a real basemap
(without one, the app falls back to the cartoonish demotiles tile set).

```bash
# Get a free MapTiler API key at https://www.maptiler.com/cloud/ (the
# Free tier covers a hobby app comfortably). Then:
echo "NEXT_PUBLIC_MAPTILER_KEY=your_key_here" > .env.production

# Or if you don't want a key, an empty file is fine:
touch .env.production
```

`.env.production` is gitignored (and won't show in the public repo) but
will be picked up by the Docker build context. The MapTiler key is
public-by-design (it ends up in the JS bundle); restrict it by domain
in MapTiler's dashboard if you care.

### 3. Bump Docker Desktop memory (one-time, if you haven't)

The Next.js production build peaks around 1.5–2 GB during the
"Collecting page data" phase. Default Docker Desktop allocations on Mac
are usually 4 GB, which is enough — but verify:

```bash
docker info | grep -i memory
```

If `Total Memory` is < 4 GiB, open Docker Desktop → Settings → Resources
and raise the memory slider to 4 GB. Restart Docker.

### 4. Build the MOTIS dataset locally

This is the one expensive step — needs ~6 GB free RAM. You only re-run
it when SEPTA's GTFS or PA OSM update (quarterly-ish):

```bash
# Source data (skip if data/ is already populated):
mkdir -p data
curl -L -o data/septa-gtfs.zip https://www3.septa.org/developer/gtfs_public.zip
unzip -p data/septa-gtfs.zip google_bus.zip > data/google_bus.zip
unzip -p data/septa-gtfs.zip google_rail.zip > data/google_rail.zip
curl -L -o data/pennsylvania-latest.osm.pbf \
  https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf

# Clip OSM to the SEPTA region:
brew install osmium-tool   # one-time
osmium extract --bbox=-76.0,39.55,-74.65,40.45 \
  data/pennsylvania-latest.osm.pbf -o data/septa-region.osm.pbf

# Build the MOTIS graph:
docker compose run --rm -w /workspace motis /motis import

# Patch onetomany_max_many in the baked config (MOTIS rebakes a copy
# at import; this is the project's quirk, see CLAUDE.md memory):
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' \
  data/data/config.yml

# Pack into the tarball the Docker image bakes in:
bun run pack:motis
ls -lh dist/motis-dataset.tar.gz   # ~120 MB
```

### 5. Deploy

```bash
bun run deploy
```

This is the only command you run for every deploy. What happens:
1. Wrangler reads `wrangler.jsonc`.
2. Wrangler invokes Docker to build the `Dockerfile`. The Next.js build
   runs (~3 min); the dataset tarball is `COPY`'d in and extracted
   into `/workspace/data` (~10 s).
3. The resulting ~700 MB image is pushed to Cloudflare's container
   registry (~1–3 min depending on your upload speed).
4. Wrangler provisions/updates the Worker and the Container binding.

Total first-deploy time: **~5–8 min**. Subsequent code-only deploys
reuse the dataset layer from cache and run in ~2–3 min.

At the end, Wrangler prints something like:
```
Published transit-isochrones (X.Xs)
  https://transit-isochrones.<your-account>.workers.dev
```

That's the deployed URL. Open it in a browser.

### 6. First request

The amber "Warming up — first query ready in ~30 s" banner shows for
the first ~25 s while MOTIS mmaps the graph. The Map UI is interactive
the whole time — pin an origin, set the slider, etc. By the time you
click Run, MOTIS is hot.

---

## Recurring tasks

### Deploy a code change

```bash
bun run deploy
```

Wrangler diffs the image. Source-only changes rebuild only the Next.js
layer; the dataset layer is reused from cache. ~2–3 min.

### Refresh the MOTIS dataset (new GTFS, etc.)

```bash
docker compose run --rm -w /workspace motis /motis import
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' data/data/config.yml
bun run pack:motis
bun run deploy
```

The new tarball is now in `dist/`; `wrangler deploy` picks it up via
the `COPY` in `Dockerfile` and bakes it into the next image push.

### Tail logs

```bash
bunx wrangler tail
```

Streams stdout/stderr from the live container in real time. Useful for
debugging failed boots.

### Change instance size

In `wrangler.jsonc`, the `containers[0].instance_type`:
- `dev` (256 MB, 1/16 vCPU) — **too small for MOTIS**
- `basic` (1 GB, 1/4 vCPU) — current default; comfortable headroom
- `standard` (4 GB, 1/2 vCPU) — bump to this for tighter polygon latency under load

Edit and `bun run deploy`.

### Use a custom domain

Default URL is `https://transit-isochrones.<your-account>.workers.dev`.
For your own:

1. Add the parent zone to Cloudflare (Sites → Add Site).
2. Uncomment the `routes` block in `wrangler.jsonc` and fill in both fields.
3. `bun run deploy`.

CF auto-provisions and renews the cert. You don't see Let's Encrypt
anywhere in this flow.

---

## How the cold-start UX works

1. Container is asleep (no traffic for `sleepAfter` = 5 min).
2. User visits the page → Worker forwards the request to the container → CF starts the container instance.
3. Next.js is listening within ~3 s; the HTML response goes out.
4. The page mounts and the client fires `/api/health`. That request
   (also forwarded to the container) is what triggers MOTIS's mmap of
   the baked-in graph. `/api/health` returns 503 for ~25 s while MOTIS
   loads.
5. The Map UI shows the amber warm-up banner, polls `/api/health`
   every 2 s. As soon as MOTIS reports ready, the banner disappears.
6. The user has been exploring the UI in the meantime, so they don't
   notice the wait.

Total: ~3 s "blank page" → HTML loads → ~25 s warm-up banner while
the user interacts → ready.

---

## Troubleshooting

**`wrangler deploy` fails on `COPY dist/motis-dataset.tar.gz`.** You
forgot `bun run pack:motis`. The Dockerfile requires the file to exist
in the build context.

**Build OOM-killed at "Collecting page data".** Docker Desktop has
< 4 GB allocated. Settings → Resources → bump memory.

**Container won't start, logs say `motis: error loading graph`.** The
dataset in the image is corrupt or built against a different MOTIS
version. Re-import locally and re-deploy.

**`/api/health` keeps 503'ing past 60 s in production.** Container ran
out of memory. `basic` (1 GB) might be too small under burst load.
Bump `instance_type` to `standard` in `wrangler.jsonc` and redeploy.

**Cold-start banner shows on every visit, even right after one.**
`sleepAfter` is too short for typical session gaps. Bump from `5m` to
`15m` or `1h` in `worker/index.ts`.
