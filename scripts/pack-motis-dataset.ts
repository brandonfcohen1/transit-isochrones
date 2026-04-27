#!/usr/bin/env bun
// Packs MOTIS's imported dataset (data/data/) into a single gzipped tarball
// for upload to object storage. The deploy-side bootstrap script
// (scripts/motis-bootstrap.sh) fetches and extracts this on container start
// so the deploy environment never has to run `motis import` itself.
//
// Workflow:
//   1. Run `motis import` locally to (re)build data/data/.
//   2. `bun run pack:motis` — produces dist/motis-dataset.tar.gz.
//   3. Upload to whatever object storage you use (R2, S3, B2, GCS):
//        rclone copy dist/motis-dataset.tar.gz r2:my-bucket/
//        aws s3 cp dist/motis-dataset.tar.gz s3://my-bucket/
//   4. Set MOTIS_DATASET_URL on the deploy to the public/signed URL.
//   5. Container boot fetches and extracts on first start (or whenever
//      the marker file is missing).
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
console.log("Upload to object storage. Examples:");
console.log(`  rclone copy ${OUT_FILE} r2:your-bucket/`);
console.log(`  aws s3 cp ${OUT_FILE} s3://your-bucket/ --acl public-read`);
console.log("");
console.log("Then set MOTIS_DATASET_URL on the deploy to the public URL.");
