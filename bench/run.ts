#!/usr/bin/env bun
// Benchmark harness for the isochrone stack.
// Measures three stages end-to-end so before/after comparisons are attributable:
//   1. MOTIS raw /one-to-all (C++ compute + transport)
//   2. /api/isochrone single-time (MOTIS + merge + JSON ship)
//   3. /api/isochrone best-case (MOTIS fan-out + polygon)
//
// Run:   bun run bench        # or: bun bench/run.ts
// Flags: --trials=N (default 5)   --save=path (default bench/results/<ts>.json)
//
// Output: markdown table to stdout + JSON results file for diffing runs.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reachable } from "@motis-project/motis-client";

type SlimStop = { id: string; lat: number; lon: number; d: number };

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
  // Skip p95 when n < 20 — with 5 trials `ms[floor(0.95*5)] = ms[4] = max`
  // so the stat is indistinguishable from `max` and misleads anyone
  // reading the table. Restored automatically at higher trial counts.
  const p95 = ms.length >= 20 ? p(0.95) : null;
  return { min: ms[0], p50: p(0.5), p95, max: ms[ms.length - 1], mean: sum / ms.length, bytes, count };
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

async function measureApi(bestCase: boolean, noCacheSalt?: number, minutes: number = MINUTES): Promise<Sample> {
  const q = new URLSearchParams({
    lat: String(LAT),
    lon: String(LON),
    minutes: String(minutes),
    time: TIME,
  });
  if (bestCase) {
    const datePart = TIME.split("T")[0];
    const times: string[] = [];
    // Hourly sampling from 5am-11pm = 18 times, matching the prod client.
    // Earlier 5-min (216) sampling was superseded by rail sub-sampling on
    // the server; removed to keep the bench aligned with the actual prod
    // path (also now caps at 24 timesCsv entries).
    for (let h = 5; h < 23; h++) {
      times.push(`${datePart}T${String(h).padStart(2, "0")}:00:00Z`);
    }
    q.set("timesCsv", times.join(","));
  }
  // To bust the server-side LRU across trials (for cold-run measurement),
  // vary the origin by enough to escape the cache's 3-decimal snap grid
  // (~110 m). At 0.002° ≈ 220 m per salt step, salts 1..5 all land in
  // distinct buckets.
  if (noCacheSalt) {
    const jitter = noCacheSalt * 0.002;
    q.set("lat", String(LAT + jitter));
  }
  const [res, ms] = await timed(() => fetch(`${APP_URL}/api/isochrone?${q}`));
  const body = await res.arrayBuffer();
  if (!res.ok) throw new Error(`api http ${res.status}: ${new TextDecoder().decode(body).slice(0, 200)}`);
  const parsed = JSON.parse(new TextDecoder().decode(body)) as { stops?: SlimStop[] };
  return { ms, bytes: body.byteLength, count: parsed.stops?.length ?? 0 };
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
  // Seed the salt from the timestamp modulo a small band so back-to-back
  // benches don't reuse each other's already-cached salted origins, but
  // the resulting lat jitter stays within the SEPTA coverage area (~±10
  // meters × salt). Max salt offset ≈ 0.02° ≈ 2km.
  let salt = (Math.floor(Date.now() / 1000) % 100) + 1;
  const stages = [
    await runStage("motis /one-to-all (raw)", measureMotis),
    await runStage("/api/isochrone single — cold", () => measureApi(false, salt++)),
    await runStage("/api/isochrone single — warm", () => measureApi(false, 0)),
    await runStage("/api/isochrone best-case (18) — cold", () => measureApi(true, salt++)),
    await runStage("/api/isochrone best-case (18) — warm", () => measureApi(true, 0)),
    // 60-min budget rows — adaptive cell size benefits this dimension
    // most. Cold here tracks the 3-4x improvement seen on the sweep.
    await runStage("/api/isochrone 60min single — cold", () => measureApi(false, salt++, 60)),
    await runStage("/api/isochrone 60min best-case (18) — cold", () => measureApi(true, salt++, 60)),
  ];

  // p95 omitted when n < 20 (would otherwise equal max and mislead).
  const showP95 = stages.some((s) => s.p95 != null);
  const header = showP95
    ? "| stage | min | p50 | p95 | max | mean | payload | stops |"
    : "| stage | min | p50 | max | mean | payload | stops |";
  const sep = showP95 ? "|---|---:|---:|---:|---:|---:|---:|---:|" : "|---|---:|---:|---:|---:|---:|---:|";
  console.log(header);
  console.log(sep);
  for (const s of stages) {
    const row = showP95
      ? `| ${s.name} | ${fmt(s.min)} | ${fmt(s.p50)} | ${s.p95 != null ? fmt(s.p95) : "—"} | ${fmt(s.max)} | ${fmt(s.mean)} | ${kb(s.bytes)} | ${s.count ?? "-"} |`
      : `| ${s.name} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${kb(s.bytes)} | ${s.count ?? "-"} |`;
    console.log(row);
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
