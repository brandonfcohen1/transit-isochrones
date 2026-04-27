# Single-container build: MOTIS + Next.js running under supervisord.
#
# Layout:
#   /motis           — MOTIS binary (from base image)
#   /workspace       — bind-mount or fetched at boot; contains MOTIS data dir
#   /app             — Next.js standalone bundle
#
# Two ways to provision the MOTIS dataset:
#
#   (a) Build locally, bind-mount (best for development):
#         docker run --rm -v $(pwd)/data:/workspace -w /workspace septa-iso /motis import
#         docker run -d -v $(pwd)/data:/workspace -p 3000:3000 septa-iso
#
#   (b) Pre-build, host on object storage, fetch at boot (best for cloud
#       deploy on small VMs that can't run `motis import` themselves):
#         bun run pack:motis            # → dist/motis-dataset.tar.gz
#         rclone copy dist/motis-dataset.tar.gz r2:bucket/  # or aws s3 cp …
#         docker run -d -e MOTIS_DATASET_URL=https://… -p 3000:3000 septa-iso
#       The container's motis-bootstrap.sh fetches and extracts on first
#       start. Subsequent restarts skip the fetch via .bootstrapped marker.

# ─── Stage 1: build the Next.js app ─────────────────────────────────
FROM oven/bun:1 AS app-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
RUN bun run build

# ─── Stage 2: runtime — MOTIS base + tiny Node for Next ─────────────
FROM ghcr.io/motis-project/motis:latest

USER root

# supervisord + a minimal Node (standalone Next needs node at runtime
# for the bundled server.js). `nodejs` from debian apt is fine here —
# the standalone server doesn't need a specific Node version.
RUN apt-get update && \
    apt-get install -y --no-install-recommends supervisor nodejs curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy Next standalone output. The standalone folder already contains
# server.js + the minimal node_modules subset actually imported.
# Static assets and public/ must be copied separately per Next's docs.
WORKDIR /app
COPY --from=app-build /app/.next/standalone/ ./
COPY --from=app-build /app/.next/static ./.next/static
COPY --from=app-build /app/public ./public

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY scripts/motis-bootstrap.sh /usr/local/bin/motis-bootstrap.sh
RUN chmod +x /usr/local/bin/motis-bootstrap.sh

# MOTIS_URL is set per-process in supervisord.conf; no need to export
# globally. PORT is 3000 by default (matches supervisord's HOSTNAME).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health >/dev/null || exit 1

# CMD (not ENTRYPOINT) so the operator can override at `docker run` time
# for the one-time MOTIS graph build:
#   docker run --rm -v $(pwd)/data:/workspace septa-iso /motis import
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
