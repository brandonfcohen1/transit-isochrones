#!/usr/bin/env bun
// Packs MOTIS's imported dataset (data/data/) into a single gzipped tarball.
// The Dockerfile COPYs this file and extracts it into /workspace at image
// build time; `wrangler deploy` then ships the image (with dataset baked in)
// to Cloudflare's container registry.
//
// Workflow:
//   1. Run `motis import` locally to (re)build data/data/.
//   2. `bun run pack:motis` — produces dist/motis-dataset.tar.gz.
//   3. `bun run deploy` — wrangler builds the Dockerfile (which COPYs this
//      tarball into the image) and pushes to CF.
//
// Output is gzip rather than zstd for portability — gzip is in every
// minimal container image; zstd is not.
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_DIR = join(ROOT, "data", "data");
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "motis-dataset.tar.gz");

if (!existsSync(DATASET_DIR)) {
  console.error(
    `No MOTIS dataset at ${DATASET_DIR}. Run a MOTIS import first:\n` +
      `  docker compose run --rm -w /workspace motis /motis import`,
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`Packing ${DATASET_DIR} → ${OUT_FILE}…`);
const t0 = Date.now();
// Tar the `data` directory inside `data/` (relative inside the archive)
// so the deploy bootstrap can extract straight into `/workspace`,
// recreating `/workspace/data/`.
await $`tar -czf ${OUT_FILE} -C ${join(ROOT, "data")} data`;

const size = statSync(OUT_FILE).size;
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Wrote ${(size / 1024 / 1024).toFixed(1)} MB in ${sec}s`);
console.log("");
console.log("Next: `bun run deploy` — Wrangler bakes this tarball into the");
console.log("Docker image and pushes to Cloudflare's container registry.");
