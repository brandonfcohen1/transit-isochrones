#!/usr/bin/env bun
// Builds public/rail-line-offsets.json from data/google_rail.zip — a per-line
// map of (terminus stop_id → list of upstream stops with min "minutes before
// terminus" on a representative train).
//
// Used by /api/isochrone's rail-reach correction. plan() to a terminus is
// reliable; back-filling each upstream stop's reach by subtracting its
// terminus-offset gets us the right answer for ~50 stops with ~12 plan()
// calls instead of one-per-stop. See project_rail_reach_plan_override.md.
//
// Re-run when SEPTA pushes a new GTFS feed:
//   bun run build:rail-offsets

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = join(ROOT, "data", "google_rail.zip");
const OUT = join(ROOT, "src", "lib", "rail-line-offsets.json");

// Read CSV out of the zip, strip header, return rows as arrays.
async function readCsv(name: string): Promise<string[][]> {
  const text = await $`unzip -p ${ZIP} ${name}`.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((l) => l.split(","));
}

type Row = Record<string, string>;
async function readCsvObjects(name: string): Promise<Row[]> {
  const text = await $`unzip -p ${ZIP} ${name}`.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const o: Row = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = cols[i];
    return o;
  });
}

function hms(s: string): number {
  const [h, m, sec] = s.split(":").map(Number);
  return h * 3600 + m * 60 + sec;
}

const trips = await readCsvObjects("trips.txt");
const stops = await readCsvObjects("stops.txt");
const stopTimes = await readCsv("stop_times.txt");

// Group trips by route_id; we'll pick a single representative trip per route
// (the longest in stop count, which catches full-line trains rather than
// short-turns).
const tripsByRoute = new Map<string, string[]>();
for (const t of trips) {
  const r = t.route_id;
  const id = t.trip_id;
  if (!tripsByRoute.has(r)) tripsByRoute.set(r, []);
  tripsByRoute.get(r)!.push(id);
}

// Index stop_times by trip_id → ordered [seq, stopId, depSec][]
const stIdx = new Map<string, Array<{ seq: number; stopId: string; depSec: number }>>();
const SCHEMA = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"];
const colIdx = (h: string) => SCHEMA.indexOf(h);
for (const r of stopTimes) {
  const tid = r[colIdx("trip_id")];
  const seq = Number(r[colIdx("stop_sequence")]);
  const stopId = r[colIdx("stop_id")];
  const depSec = hms(r[colIdx("departure_time")]);
  if (!stIdx.has(tid)) stIdx.set(tid, []);
  stIdx.get(tid)!.push({ seq, stopId, depSec });
}
for (const arr of stIdx.values()) arr.sort((a, b) => a.seq - b.seq);

// Pick the outlying terminus per route by distance from Suburban Station
// (a CC reference point). Many SEPTA routes are through-running services
// — Warminster → Airport, Wilmington → Temple — so "longest trip" doesn't
// cleanly identify the *outbound* terminus. Distance-from-CC does:
// Doylestown is far north, Airport E&F is far south, etc.
const CC_LAT = 39.9539;
const CC_LON = -75.1678;
const stopCoord = new Map<string, { lat: number; lon: number }>();
for (const s of stops) {
  if (s.stop_lat && s.stop_lon) {
    stopCoord.set(s.stop_id, { lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
  }
}
function distFromCC(stopId: string): number {
  const c = stopCoord.get(stopId);
  if (!c) return 0;
  const dx = (c.lon - CC_LON) * 85;
  const dy = (c.lat - CC_LAT) * 111;
  return Math.sqrt(dx * dx + dy * dy);
}

type LineEntry = {
  terminusId: string;
  terminusName: string;
  stops: Array<{ id: string; fromTerminusMin: number }>;
};
const out: Record<string, LineEntry> = {};

for (const [route, tripIds] of tripsByRoute) {
  // Pick the trip whose *last* stop is most distant from CC. That picks
  // outbound trips (which end at the line's outer terminus) over inbound
  // ones (which end in CC). Among outbound trips, ties go to the one
  // covering the most stops — gets us full line coverage rather than a
  // short-turn.
  let bestTrip: string | null = null;
  let bestDist = -1;
  let bestLen = 0;
  for (const tid of tripIds) {
    const st = stIdx.get(tid);
    if (!st || st.length === 0) continue;
    const last = st[st.length - 1];
    const d = distFromCC(last.stopId);
    if (d > bestDist || (d === bestDist && st.length > bestLen)) {
      bestDist = d;
      bestLen = st.length;
      bestTrip = tid;
    }
  }
  if (!bestTrip) continue;
  const seq = stIdx.get(bestTrip)!;
  const terminus = seq[seq.length - 1];
  const terminusName = stops.find((s) => s.stop_id === terminus.stopId)?.stop_name ?? "?";
  const lineStops: LineEntry["stops"] = seq.map((s) => ({
    id: `googlerail_${s.stopId}`,
    fromTerminusMin: Math.round((terminus.depSec - s.depSec) / 60),
  }));
  out[route] = {
    terminusId: `googlerail_${terminus.stopId}`,
    terminusName,
    stops: lineStops,
  };
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${Object.keys(out).length} lines to ${OUT}`);
for (const [route, entry] of Object.entries(out)) {
  console.log(`  ${route.padEnd(4)} terminus=${entry.terminusName} (${entry.stops.length} stops)`);
}
