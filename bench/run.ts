#!/usr/bin/env bun
// Benchmark harness for the isochrone stack.
// Measures four stages end-to-end so before/after comparisons are attributable:
//   1. MOTIS raw /one-to-all (C++ compute + transport)
//   2. /api/isochrone single-time (MOTIS + merge + JSON ship)
//   3. /api/isochrone best-case (18 MOTIS calls fanned out)
//   4. buildIsochrone (grid + marching-squares contour over N stops)
//
// Run:   bun run bench        # or: bun bench/run.ts
// Flags: --trials=N (default 5)   --save=path (default bench/results/<ts>.json)
//
// Output: markdown table to stdout + JSON results file for diffing runs.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsochrone, type SlimStop } from "../src/lib/isochrone";
import type { Reachable } from "@motis-project/motis-client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8080";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

// Philly City Hall — a dense origin so we exercise the slow path.
const LAT = 39.9526;
const LON = -75.1635;
const MINUTES = 30;
const TIME = "2026-04-20T14:00:00Z"; // Mon 10am ET

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const TRIALS = Number(args.trials ?? 5);
const WARMUP = Number(args.warmup ?? 1);

type Sample = { ms: number; bytes?: number; count?: number };

function stats(samples: Sample[]) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const sum = ms.reduce((a, b) => a + b, 0);
  const bytes = samples[0]?.bytes;
  const count = samples[0]?.count;
  return { min: ms[0], p50: p(0.5), p95: p(0.95), max: ms[ms.length - 1], mean: sum / ms.length, bytes, count };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const out = await fn();
  return [out, performance.now() - t];
}

async function measureMotis(): Promise<Sample> {
  const q = new URLSearchParams({
    one: `${LAT},${LON}`,
    maxTravelTime: String(MINUTES),
    arriveBy: "false",
    transitModes: "TRANSIT",
    preTransitModes: "WALK",
    postTransitModes: "WALK",
    time: TIME,
  });
  const [res, ms] = await timed(() => fetch(`${MOTIS_URL}/api/v1/one-to-all?${q}`));
  const body = await res.arrayBuffer();
  if (!res.ok) throw new Error(`motis http ${res.status}`);
  // Parse so we know stop count — parsing cost is attributed to the API stage, not MOTIS.
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Reachable;
  return { ms, bytes: body.byteLength, count: parsed.all?.length ?? 0 };
}

async function measureApi(bestCase: boolean, noCacheSalt?: number): Promise<Sample> {
  const q = new URLSearchParams({
    lat: String(LAT),
    lon: String(LON),
    minutes: String(MINUTES),
    time: TIME,
  });
  if (bestCase) {
    const datePart = TIME.split("T")[0];
    const times: string[] = [];
    for (let h = 5; h < 23; h++) times.push(`${datePart}T${String(h).padStart(2, "0")}:00:00Z`);
    q.set("timesCsv", times.join(","));
  }
  // To bust the server-side LRU across trials (for cold-run measurement),
  // vary the origin by a few meters per trial — the cache key snaps to 4
  // decimals (~11m), so shifting by 20m guarantees a cache miss.
  if (noCacheSalt) {
    const jitter = noCacheSalt * 0.0002;
    q.set("lat", String(LAT + jitter));
  }
  const [res, ms] = await timed(() => fetch(`${APP_URL}/api/isochrone?${q}`));
  const body = await res.arrayBuffer();
  if (!res.ok) throw new Error(`api http ${res.status}: ${new TextDecoder().decode(body).slice(0, 200)}`);
  const parsed = JSON.parse(new TextDecoder().decode(body)) as { stops?: SlimStop[] };
  return { ms, bytes: body.byteLength, count: parsed.stops?.length ?? 0 };
}

async function measurePolygon(): Promise<Sample> {
  // Fetch once outside the measured region so polygon timing is isolated.
  const q = new URLSearchParams({
    one: `${LAT},${LON}`,
    maxTravelTime: String(MINUTES),
    arriveBy: "false",
    transitModes: "TRANSIT",
    preTransitModes: "WALK",
    postTransitModes: "WALK",
    time: TIME,
  });
  const res = await fetch(`${MOTIS_URL}/api/v1/one-to-all?${q}`);
  const reachable = (await res.json()) as Reachable;
  const stops: SlimStop[] = [];
  for (const p of reachable.all ?? []) {
    if (!p.place || p.duration == null) continue;
    stops.push({
      id: p.place.stopId ?? `${p.place.lat.toFixed(5)},${p.place.lon.toFixed(5)}`,
      lat: p.place.lat,
      lon: p.place.lon,
      d: p.duration,
    });
  }
  const [poly, ms] = await timed(async () =>
    buildIsochrone({ lat: LAT, lon: LON }, stops, MINUTES),
  );
  const bytes = poly ? new TextEncoder().encode(JSON.stringify(poly)).byteLength : 0;
  return { ms, bytes, count: stops.length };
}

async function runStage(name: string, fn: () => Promise<Sample>, trials = TRIALS) {
  process.stderr.write(`  ${name}: warmup…`);
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: Sample[] = [];
  for (let i = 0; i < trials; i++) {
    const s = await fn();
    samples.push(s);
    process.stderr.write(` ${s.ms.toFixed(0)}`);
  }
  process.stderr.write(" ✓\n");
  const s = stats(samples);
  return { name, ...s, samples };
}

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(1)}ms`;
}
function kb(n?: number) {
  return n == null ? "-" : n >= 1024 * 1024 ? `${(n / 1048576).toFixed(2)}MB` : `${(n / 1024).toFixed(1)}KB`;
}

async function main() {
  console.log(`# isochrone bench — ${TRIALS} trials (warmup ${WARMUP})`);
  console.log(`origin: ${LAT},${LON}  minutes: ${MINUTES}  time: ${TIME}`);
  console.log(`motis: ${MOTIS_URL}   app: ${APP_URL}\n`);

  // Each trial of *cold* api uses a different origin to dodge the LRU so we
  // measure the full MOTIS+polygon path. Warm measures LRU-hit latency.
  let salt = 1;
  const stages = [
    await runStage("motis /one-to-all (raw)", measureMotis),
    await runStage("buildIsochrone (polygon only)", measurePolygon),
    await runStage("/api/isochrone single — cold", () => measureApi(false, salt++)),
    await runStage("/api/isochrone single — warm", () => measureApi(false, 0)),
    await runStage("/api/isochrone best-case (18) — cold", () => measureApi(true, salt++)),
    await runStage("/api/isochrone best-case (18) — warm", () => measureApi(true, 0)),
  ];

  console.log("| stage | min | p50 | p95 | max | mean | payload | stops |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of stages) {
    console.log(
      `| ${s.name} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${kb(s.bytes)} | ${s.count ?? "-"} |`,
    );
  }

  const outDir = join(ROOT, "bench", "results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const path = String(args.save ?? join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  writeFileSync(
    path,
    JSON.stringify({ at: new Date().toISOString(), origin: { LAT, LON }, minutes: MINUTES, time: TIME, stages }, null, 2),
  );
  console.log(`\nresults → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
