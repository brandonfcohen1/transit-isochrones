# Single-image build: MOTIS + Next.js running under supervisord.
# Targets Cloudflare Containers (ephemeral disk per cold start), so the
# MOTIS dataset is baked into the image rather than fetched at runtime.
#
# Layout:
#   /motis           — MOTIS binary (from upstream base image)
#   /workspace/data  — pre-built MOTIS graph, baked in below
#   /app             — Next.js standalone bundle
#
# Build:
#   bun run pack:motis     # → dist/motis-dataset.tar.gz
#   wrangler deploy        # builds this Dockerfile, pushes to CF registry
#
# Local dev (bind-mount): `docker compose up motis` uses the upstream
# MOTIS image directly — see docker-compose.yml.

# ─── Stage 1: build the Next.js app ─────────────────────────────────
FROM oven/bun:1 AS app-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
# Next.js's "Collecting page data" phase parallelizes across CPUs and
# OOMs in build containers with limited memory (~7-8 workers × ~300 MB
# each = peak >2 GB just for that phase). Cap parallelism to keep peak
# RAM modest; build wall-clock barely moves on a 7-page app.
ENV NEXT_PRIVATE_WORKER=1
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN bun run build

# ─── Stage 2: runtime — MOTIS base + tiny Node for Next ─────────────
FROM ghcr.io/motis-project/motis:latest

USER root

# MOTIS's upstream image is Alpine 3.20. Add Node (for Next.js standalone)
# and curl (for the in-container healthcheck).
RUN apk add --no-cache nodejs curl ca-certificates

# Copy Next standalone output. The standalone folder already contains
# server.js + the minimal node_modules subset actually imported.
# Static assets and public/ must be copied separately per Next's docs.
WORKDIR /app
COPY --from=app-build /app/.next/standalone/ ./
COPY --from=app-build /app/.next/static ./.next/static
COPY --from=app-build /app/public ./public

COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# Bake the MOTIS dataset into the image. On Cloudflare Containers each
# cold start gets a fresh ephemeral disk, so fetching from R2 every time
# would add ~90 s download to every cold start. Baking it in gives a
# bigger image (~600 MB) but a clean ~25 s cold start (just MOTIS graph
# mmap). Run `bun run pack:motis` locally to produce this file before
# `wrangler deploy`.
COPY dist/motis-dataset.tar.gz /tmp/motis-dataset.tar.gz
RUN mkdir -p /workspace \
    && tar -xzf /tmp/motis-dataset.tar.gz -C /workspace \
    && rm /tmp/motis-dataset.tar.gz

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health >/dev/null || exit 1

CMD ["/usr/local/bin/start.sh"]
