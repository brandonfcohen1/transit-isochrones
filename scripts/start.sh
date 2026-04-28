#!/bin/sh
# Container entrypoint. Starts MOTIS in the background, then exec's
# Next.js as PID 1. Cloudflare Containers' port-readiness probe hits
# :3000 within ~20 s — Next.js needs to bind it fast, which means we
# can't have MOTIS's CPU-intensive graph mmap competing for the same
# scheduler at startup.
#
# When PID 1 (Next.js) exits, the kernel reaps the whole pid namespace
# so MOTIS gets cleaned up automatically — no supervisor needed. The &
# trap forwards SIGTERM to MOTIS so docker stop / CF stop is graceful.
set -eu

cleanup() {
  kill -TERM "${motis_pid:-0}" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

(cd /workspace && /motis server /workspace/data) &
motis_pid=$!

cd /app
export MOTIS_URL="http://127.0.0.1:8080"
export NODE_ENV=production
export PORT=3000
export HOSTNAME=0.0.0.0
exec node server.js
