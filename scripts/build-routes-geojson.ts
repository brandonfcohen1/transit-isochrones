#!/usr/bin/env bun
// Builds public/septa-routes.geojson from the GTFS zips in data/.
// One MultiLineString feature per route, limited to rail-like modes
// (route_type 0/1/2 — trolley, subway, Regional Rail). Buses are excluded
// to keep the overlay readable.
//
// Run: `bun run build:routes`
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const OUT = join(ROOT, "public", "septa-routes.geojson");
const TMP = join(ROOT, ".gtfs-tmp");

const FEEDS = ["google_bus.zip", "google_rail.zip"] as const;
const ALLOWED_TYPES = new Set([0, 1, 2]); // tram, subway, rail

type Route = {
  id: string;
  short: string;
  long: string;
  type: number;
  color: string;
};

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function readCsv(path: string): Promise<{ header: string[]; rows: string[][] }> {
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/);
  const header = parseLine(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    rows.push(parseLine(lines[i]));
  }
  return { header, rows };
}

const round = (n: number) => Math.round(n * 1e5) / 1e5; // ~1m precision

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const routes = new Map<string, Route>(); // key: `${feed}:${route_id}`
const shapeToRoute = new Map<string, string>(); // `${feed}:${shape_id}` → route key
const shapePts = new Map<string, [number, number, number][]>(); // [lon,lat,seq]

for (const zipName of FEEDS) {
  const feed = zipName.replace(".zip", "");
  const dest = join(TMP, feed);
  mkdirSync(dest, { recursive: true });
  await $`unzip -oq ${join(DATA, zipName)} -d ${dest}`.quiet();

  // routes.txt — keep only allowed types
  {
    const { header, rows } = await readCsv(join(dest, "routes.txt"));
    const idx = (n: string) => header.indexOf(n);
    const iId = idx("route_id"),
      iShort = idx("route_short_name"),
      iLong = idx("route_long_name"),
      iType = idx("route_type"),
      iColor = idx("route_color");
    for (const r of rows) {
      const type = Number(r[iType]);
      if (!ALLOWED_TYPES.has(type)) continue;
      routes.set(`${feed}:${r[iId]}`, {
        id: r[iId],
        short: r[iShort] || "",
        long: r[iLong] || "",
        type,
        color: `#${r[iColor] || "888888"}`,
      });
    }
  }

  // trips.txt — only rows whose route we kept
  {
    const { header, rows } = await readCsv(join(dest, "trips.txt"));
    const iRoute = header.indexOf("route_id");
    const iShape = header.indexOf("shape_id");
    for (const r of rows) {
      const routeKey = `${feed}:${r[iRoute]}`;
      if (!routes.has(routeKey)) continue;
      const sid = r[iShape];
      if (!sid) continue;
      const shapeKey = `${feed}:${sid}`;
      if (!shapeToRoute.has(shapeKey)) shapeToRoute.set(shapeKey, routeKey);
    }
  }

  // shapes.txt — only shapes we need
  {
    const { header, rows } = await readCsv(join(dest, "shapes.txt"));
    const iId = header.indexOf("shape_id");
    const iLat = header.indexOf("shape_pt_lat");
    const iLon = header.indexOf("shape_pt_lon");
    const iSeq = header.indexOf("shape_pt_sequence");
    for (const r of rows) {
      const shapeKey = `${feed}:${r[iId]}`;
      if (!shapeToRoute.has(shapeKey)) continue;
      let pts = shapePts.get(shapeKey);
      if (!pts) {
        pts = [];
        shapePts.set(shapeKey, pts);
      }
      pts.push([round(Number(r[iLon])), round(Number(r[iLat])), Number(r[iSeq])]);
    }
  }
}

// Sort each shape by sequence, group by route.
const routeShapes = new Map<string, [number, number][][]>();
for (const [shapeKey, routeKey] of shapeToRoute) {
  const pts = shapePts.get(shapeKey);
  if (!pts || pts.length < 2) continue;
  pts.sort((a, b) => a[2] - b[2]);
  const coords: [number, number][] = pts.map((p) => [p[0], p[1]]);
  let list = routeShapes.get(routeKey);
  if (!list) {
    list = [];
    routeShapes.set(routeKey, list);
  }
  list.push(coords);
}

const features = [];
for (const [routeKey, shapes] of routeShapes) {
  const route = routes.get(routeKey)!;
  features.push({
    type: "Feature" as const,
    properties: {
      route_id: route.id,
      short_name: route.short,
      long_name: route.long,
      route_type: route.type,
      route_color: route.color,
    },
    geometry: {
      type: "MultiLineString" as const,
      coordinates: shapes,
    },
  });
}

await Bun.write(OUT, JSON.stringify({ type: "FeatureCollection", features }));
const bytes = (await Bun.file(OUT).arrayBuffer()).byteLength;
console.log(`Wrote ${features.length} routes (${(bytes / 1024).toFixed(1)} KB) to ${OUT}`);
rmSync(TMP, { recursive: true, force: true });
