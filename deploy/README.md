# Deploy: Hetzner CPX11 + Cloudflare R2

End-to-end deploy of the SEPTA isochrone app to a single $4/mo VPS, with
the MOTIS dataset hosted on Cloudflare R2 (free tier).

**What you'll need:**
- Hetzner Cloud account ([hetzner.com/cloud](https://hetzner.com/cloud))
- Cloudflare account with R2 enabled (free)
- A domain you control, with a DNS A record you can edit
- ssh keypair on your laptop (`~/.ssh/id_ed25519.pub` or similar)
- This repo on a git host (so the server can `git clone` it)

**Time:** ~30 min the first time, ~5 min for subsequent code deploys.

**Recurring cost:** $4.13/mo (Hetzner CPX11) + $0 (R2 under free tier) = **$4.13/mo**.

---

## 0. One-time, on your laptop

### Build and pack the MOTIS dataset

This needs ~6 GB free RAM (don't run on a small VPS). Output is the
`dist/motis-dataset.tar.gz` you'll upload to R2.

```bash
# Refresh the source data (skip if data/ is already populated):
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

# Patch onetomany_max_many in the baked config (MOTIS bakes a copy at import):
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' \
  data/data/config.yml

# Pack into a tarball:
bun run pack:motis
ls -lh dist/motis-dataset.tar.gz   # ~145 MB
```

### Upload the tarball to R2

In the Cloudflare dashboard: **R2** → **Create bucket** (any name; e.g. `septa-iso-data`). Then upload `dist/motis-dataset.tar.gz`. Two paths:

**A. Public bucket** (simplest): in the bucket's **Settings** tab, enable **R2.dev subdomain**. The file is reachable at `https://pub-<hash>.r2.dev/motis-dataset.tar.gz`. No auth.

**B. Custom domain or signed URL**: skip if A is fine for a hobby app. The file is just SEPTA's public GTFS + a public OSM extract — there's nothing sensitive to hide.

Note the URL — it goes in the server's `.env` as `MOTIS_DATASET_URL`.

---

## 1. Create the server

Hetzner Cloud console → **Add Server**:

- **Location**: Ashburn (closest to Philly users)
- **Image**: Ubuntu 24.04
- **Type**: **CPX11** ($4.13/mo, 2 vCPU AMD, 2 GB RAM, 40 GB SSD). CX22 ($4.51) also works if you want extra headroom.
- **Networking**: leave IPv4 + IPv6 enabled
- **Cloud config**: paste the contents of `deploy/cloud-init.yml`. **Edit the `ssh_authorized_keys` line first** to put your real public key there.
- **Name**: `septa-iso`
- Click **Create**

Hetzner gives you a public IPv4 immediately. Cloud-init runs in the
background for ~3–5 min after boot. While that runs:

### Point DNS at the server

In your DNS provider, create an A record:
```
septa-iso.your-domain.com  →  <server-ip-from-hetzner>
```
TTL 300 is fine. Wait for it to propagate (`dig septa-iso.your-domain.com` should return the new IP).

---

## 2. Deploy the app

ssh in (cloud-init has finished when this works without password):

```bash
ssh deploy@<server-ip>
git clone https://github.com/<you>/septa-iso
cd septa-iso/deploy
cp .env.example .env
$EDITOR .env                  # paste the R2 URL into MOTIS_DATASET_URL
$EDITOR Caddyfile             # replace example.com with your domain + email
docker compose -f docker-compose.prod.yml up -d --build
```

The first `up -d --build` takes ~5 min: Next.js builds (~3 min, peaks
~1.5 GB swap-assisted), the image is assembled, the container starts,
the bootstrap fetches the 145 MB tarball from R2, MOTIS mmaps the graph.
Caddy hits Let's Encrypt and gets a real cert in ~30 s once your DNS
points at the server.

Watch it come up:
```bash
docker compose -f docker-compose.prod.yml logs -f
```

When `app` reports `MOTIS up` and `Ready`, hit `https://septa-iso.your-domain.com` in a browser. Done.

---

## 3. Recurring tasks

### Deploy a code change

```bash
ssh deploy@<server-ip>
cd septa-iso
git pull
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
```

`build` only rebuilds the Next.js layer when source changed; ~1–2 min.

### Refresh the MOTIS dataset (new GTFS, etc.)

On your laptop:
```bash
# Re-import + re-pack + re-upload (overwrite the same R2 object)
docker compose run --rm -w /workspace motis /motis import
sed -i '' 's/onetomany_max_many: 128/onetomany_max_many: 1024/' data/data/config.yml
bun run pack:motis
rclone copy dist/motis-dataset.tar.gz r2:septa-iso-data/
```

On the server:
```bash
ssh deploy@<server-ip>
cd septa-iso/deploy
docker compose -f docker-compose.prod.yml down app
docker volume rm deploy_workspace   # forces re-fetch
docker compose -f docker-compose.prod.yml up -d app
```

### OS updates

`unattended-upgrades` from cloud-init handles security patches. For
kernel updates that need a reboot, ssh in once a quarter:
```bash
sudo apt update && sudo apt upgrade -y && sudo reboot
```

---

## Troubleshooting

**Caddy says "no such host" or self-signs the cert.** DNS hadn't propagated when Caddy started its ACME challenge. Wait, then `docker compose restart caddy`.

**`/api/health` returns 503.** MOTIS hasn't loaded yet (first boot fetches the tarball + mmaps the graph; ~60–90 s). Tail `docker compose logs -f app` and look for `motis.server`.

**OOM during `--build`.** Cloud-init should have created 2 GB swap; check `free -h`. If swap is missing for some reason: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`.

**Anything weird and you want to start over.** From the Hetzner console: delete the server (€0.001/h hourly billing — only what you used), create a new one with the same cloud-init. The R2 dataset persists.
