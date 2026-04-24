# Single-container build: MOTIS + Next.js running under supervisord.
#
# Layout:
#   /motis           — MOTIS binary (from base image)
#   /workspace       — mounted by the operator; contains MOTIS data dir + GTFS/OSM
#   /app             — Next.js standalone bundle
#
# One-time graph build (operator runs this once against the same image).
# Needs `-w /workspace` so MOTIS writes the preprocessed graph next to
# the mounted data files:
#   docker run --rm -v $(pwd)/data:/workspace -w /workspace septa-iso /motis import
#
# Daily run:
#   docker run -d -v $(pwd)/data:/workspace -p 3000:3000 septa-iso

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

# MOTIS_URL is set per-process in supervisord.conf; no need to export
# globally. PORT is 3000 by default (matches supervisord's HOSTNAME).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health >/dev/null || exit 1

# CMD (not ENTRYPOINT) so the operator can override at `docker run` time
# for the one-time MOTIS graph build:
#   docker run --rm -v $(pwd)/data:/workspace septa-iso /motis import
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
