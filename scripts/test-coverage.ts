#!/usr/bin/env bun
// Golden-set regression test for rail coverage + no-go zones.
//
// Why this exists: through many rounds of refactoring (match distance,
// cell size, minRingM2 filter, simplify tolerance, water mask, anchor
// rasterization strategy) we kept silently breaking suburban rail
// coverage. Every individual fix was fine in isolation; the chain
// from "oneToAll returns station" → "station appears as anchor" →
// "anchor disk rasterizes cells" → "cells survive filter" → "contour
// produces polygon" → "simplify doesn't collapse" has too many fragile
// links for manual review. This script is the compact assertion that
// catches any link failing.
//
// Run:  bun run test:coverage
// Env:  APP_URL (default http://localhost:3000)
// Exits nonzero on any failure. CI-friendly.

type LonLat = [number, number];

type CaseSpec = {
  name: string;
  origin: LonLat; // [lon, lat]
  minutes: number;
  bestCase: boolean;
  // Substrings to match against stop `.n`. Each substring must match a
  // stop in the response, AND the matched stop's coords must be inside
  // the polygon (any band).
  expectRailCovered: string[];
  // Substrings that should NOT appear in the stops list at all (e.g.
  // origins where truly unreachable rail lines out of SEPTA coverage).
  // Optional.
  expectRailMissing?: string[];
  // Lon/lat points that MUST NOT be inside the polygon (water bleed
  // checks + legitimate no-reach zones).
  expectUnreachable: Array<{ label: string; point: LonLat }>;
};

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

// Pick a test date 7 days out so it stays inside MOTIS's num_days
// timetable window regardless of when the test runs. Anchor at 14:00 UTC
// (mid-morning ET, weekday service assumed). Hardcoded dates went stale
// after ~mid-June 2026 when the rolling 60-day calendar moved past them.
function pickTestDate(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const TEST_DATE = pickTestDate();
const TEST_TIME_UTC = `${TEST_DATE}T14:00:00Z`;

const CASES: CaseSpec[] = [
  {
    // City Hall, best-case 30 min walk. The cornerstone test — almost
    // every rail line has a station reachable, so this exercises the
    // full pipeline.
    name: "City Hall · best-case 30min walk",
    origin: [-75.1635, 39.9526],
    minutes: 30,
    bestCase: true,
    expectRailCovered: [
      // Stations reached with ≥3 min walking budget — enough to have
      // a visible polygon disk around them. Edge stations reached at
      // 28-30 min (Manayunk, Germantown, etc.) are in the stops list
      // but may not produce a visible polygon disk because their 1-2
      // min walk budget snaps to a single OSM-matched cell — shown
      // via the station dot marker layer instead.
      "Suburban Station",
      "Jefferson Station",
      "Temple University",
      "Gray 30th St Station",
      "North Broad",
      "Wissahickon",
      "Overbrook",
      "Bala",
      "Fern Rock",
      "Olney",
    ],
    expectUnreachable: [
      // Points in the Delaware away from any walkable crossing. BF
      // Bridge and Tacony-Palmyra Bridge are walkable so cells near
      // them WILL reach — those aren't bugs.
      { label: "Delaware mid-river south of Ben Franklin Bridge", point: [-75.133, 39.938] },
      { label: "Delaware mid-river near Whitman (south)", point: [-75.14, 39.905] },
    ],
  },
  {
    name: "City Hall · best-case 60min walk",
    origin: [-75.1635, 39.9526],
    minutes: 60,
    bestCase: true,
    expectRailCovered: [
      "Ardmore",
      "Bryn Mawr",
      "Haverford",
      "Jenkintown-Wyncote",
      "Elkins Park",
      "Conshohocken",
    ],
    expectUnreachable: [
      { label: "Delaware mid-river south of BF", point: [-75.133, 39.938] },
    ],
  },
  {
    name: "30th St · best-case 30min walk",
    origin: [-75.1823, 39.9566],
    minutes: 30,
    bestCase: true,
    expectRailCovered: [
      "Suburban Station",
      "30th St",
      "Temple",
      "Wissahickon",
      "Overbrook",
    ],
    expectUnreachable: [
      // No Schuylkill test here — 30th St is adjacent to every
      // walkable Schuylkill crossing (30th, Chestnut, South, Spring
      // Garden, Fairmount), so essentially every point in the river
      // within 30 min walking budget IS reachable via some bridge
      // or path. This isn't a bug; it's accurate walking reach.
    ],
  },
  {
    name: "Jenkintown · best-case 30min walk",
    origin: [-75.1288, 40.0932],
    minutes: 30,
    bestCase: true,
    expectRailCovered: [
      "Jenkintown",
      "Elkins Park",
      "Melrose Park",
    ],
    expectUnreachable: [],
  },
];

type SlimStop = { id: string; lat: number; lon: number; d: number; m: string; n?: string };
type Feature = { type: "Feature"; properties?: Record<string, unknown>; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } };
type FC = { type: "FeatureCollection"; features: Feature[] };

function hourlyTimesCsv(date: string): string {
  const out: string[] = [];
  // 12 hourly samples; stays under the server's 24-entry cap.
  for (let h = 10; h < 22; h++) out.push(`${date}T${String(h).padStart(2, "0")}:00:00Z`);
  return out.join(",");
}

function inRing(pt: LonLat, ring: number[][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = [ring[i][0], ring[i][1]];
    const [xj, yj] = [ring[j][0], ring[j][1]];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInFeature(pt: LonLat, f: Feature): boolean {
  const g = f.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || !inRing(pt, outer)) continue;
    let insideHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (inRing(pt, poly[i])) { insideHole = true; break; }
    }
    if (!insideHole) return true;
  }
  return false;
}

function pointInAnyBand(pt: LonLat, fc: FC | null): boolean {
  if (!fc) return false;
  for (const f of fc.features) if (pointInFeature(pt, f)) return true;
  return false;
}

async function runCase(spec: CaseSpec): Promise<{ pass: boolean; failures: string[] }> {
  const failures: string[] = [];
  const [lon, lat] = spec.origin;
  const q = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    minutes: String(spec.minutes),
    time: TEST_TIME_UTC,
  });
  if (spec.bestCase) q.set("timesCsv", hourlyTimesCsv(TEST_DATE));

  const res = await fetch(`${APP_URL}/api/isochrone?${q}`);
  if (!res.ok) {
    failures.push(`HTTP ${res.status}`);
    return { pass: false, failures };
  }
  const body = (await res.json()) as { stops: SlimStop[]; polygon: FC | null };
  const { stops, polygon } = body;

  // Assertion 1: each expected rail stop is in the stops list AND
  // covered by a polygon band.
  for (const needle of spec.expectRailCovered) {
    const s = stops.find((x) => x.m === "rail" && (x.n ?? "").includes(needle));
    if (!s) {
      failures.push(`rail "${needle}" not in stops (MOTIS didn't reach it)`);
      continue;
    }
    const pt: LonLat = [s.lon, s.lat];
    if (!pointInAnyBand(pt, polygon)) {
      failures.push(`rail "${needle}" in stops at ${s.d}min but polygon doesn't cover it (anchor walk missing?)`);
    }
  }

  // Assertion 2: expected-missing rail stations are not in the stops list.
  for (const needle of spec.expectRailMissing ?? []) {
    const s = stops.find((x) => x.m === "rail" && (x.n ?? "").includes(needle));
    if (s) failures.push(`rail "${needle}" unexpectedly in stops at ${s.d}min`);
  }

  // Assertion 3: each unreachable point is not inside any band.
  for (const { label, point } of spec.expectUnreachable) {
    if (pointInAnyBand(point, polygon)) {
      failures.push(`${label} ${point} should be unreachable but polygon covers it (water mask leak?)`);
    }
  }

  return { pass: failures.length === 0, failures };
}

async function main() {
  console.log(`Coverage test against ${APP_URL}\n`);
  let passed = 0;
  let failed = 0;
  for (const c of CASES) {
    process.stdout.write(`  ${c.name} … `);
    const t0 = performance.now();
    const r = await runCase(c);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.pass) {
      console.log(`✓ (${dt}s)`);
      passed++;
    } else {
      console.log(`✗ (${dt}s)`);
      for (const f of r.failures) console.log(`      · ${f}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
