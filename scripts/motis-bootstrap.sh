#!/bin/sh
# Bootstrap MOTIS dataset on container start.
#
# If /workspace/data already has a marker file (.bootstrapped), skip and
# exec MOTIS directly. Otherwise, fetch a pre-built dataset from
# MOTIS_DATASET_URL, extract it into /workspace, mark, and exec.
#
# This is what makes the small-VM deploy pattern work: the deploy server
# never runs `motis import` (which needs ~4-8 GB RAM and 5-15 min on PA-
# sized data). It downloads a pre-built tarball that was built once on
# the operator's laptop or a beefy ephemeral VM.
#
# Env:
#   MOTIS_DATASET_URL  HTTPS URL to a tar.gz produced by
#                      scripts/pack-motis-dataset.ts. Optional — if
#                      unset, we assume the dataset is already mounted
#                      or baked into the image.
#
# Exec form: `exec /motis server /workspace/data` so PID 1 is MOTIS,
# signals propagate cleanly, and supervisord's process tracking works.
set -eu

WORKSPACE="${WORKSPACE_DIR:-/workspace}"
DATASET_DIR="${WORKSPACE}/data"
MARKER="${DATASET_DIR}/.bootstrapped"

if [ -f "${MARKER}" ]; then
  echo "[motis-bootstrap] dataset already present (${MARKER}); skipping fetch"
elif [ -z "${MOTIS_DATASET_URL:-}" ]; then
  if [ -d "${DATASET_DIR}" ] && [ "$(ls -A "${DATASET_DIR}" 2>/dev/null)" ]; then
    echo "[motis-bootstrap] no MOTIS_DATASET_URL set, but ${DATASET_DIR} is non-empty; assuming bind-mount"
  else
    echo "[motis-bootstrap] FATAL: no MOTIS_DATASET_URL set and ${DATASET_DIR} is empty" >&2
    echo "[motis-bootstrap] either bind-mount a pre-imported dataset or set MOTIS_DATASET_URL" >&2
    exit 1
  fi
else
  echo "[motis-bootstrap] fetching dataset from ${MOTIS_DATASET_URL}"
  mkdir -p "${WORKSPACE}"
  # Stream curl → tar so we don't need to write the tarball to disk
  # (small VMs may not have spare disk for 1+ GB scratch). gzip is in
  # every minimal image; zstd is not, so we standardize on tar.gz.
  curl -fsSL "${MOTIS_DATASET_URL}" | tar -xzf - -C "${WORKSPACE}"
  touch "${MARKER}"
  echo "[motis-bootstrap] dataset extracted to ${DATASET_DIR}"
fi

exec /motis server "${DATASET_DIR}"
