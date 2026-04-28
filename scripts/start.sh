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

# Supervise MOTIS in a respawn loop. MOTIS can die under sustained
# CPU pressure on small CF instances (we saw it crash hard during a
# heavy plan() fan-out and stay dead — Next.js kept serving but every
# /api/* call returned 503). The respawn keeps the container useful
# instead of needing CF to recycle the whole instance. 2 s pause
# between respawns avoids tight crash loops if the dataset is bad.
motis_supervisor() {
  while true; do
    (cd /workspace && /motis server /workspace/data)
    echo "[start.sh] motis exited; respawning in 2 s" >&2
    sleep 2
  done
}
motis_supervisor &
motis_pid=$!

cd /app
export MOTIS_URL="http://127.0.0.1:8080"
# CF Containers' ½ vCPU is much slower than a typical dev box, so cold
# polygon fan-outs need a longer per-call timeout. 45 s covers the
# slowest oneToAll under contention while still cutting off a real hang.
export MOTIS_TIMEOUT_MS="${MOTIS_TIMEOUT_MS:-45000}"
# Cap parallelism so 50+ best-case fan-out queries don't dogpile MOTIS
# on the small CPU. 8 keeps mean latency roughly flat with 32 on a big
# box but avoids the queue-buildup pathology under CPU contention.
export MOTIS_CONCURRENCY="${MOTIS_CONCURRENCY:-8}"
export NODE_ENV=production
export PORT=3000
export HOSTNAME=0.0.0.0
exec node server.js
