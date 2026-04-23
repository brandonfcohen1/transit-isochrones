// Rail-station reach probe via MOTIS /api/v1/plan.
//
// Why this exists: `oneToAll` is a single-instant query. If the fastest
// path to a rail station involves waiting ~10 min for the next train,
// oneToAll at the exact wrong moment reports that station as "too far"
// and drops it — even though plan's timetableView window would find a
// 29-min trip by starting 13 min later. Symptom: Paoli-line stops
// (Ardmore, Haverford, Bryn Mawr) never showed up in the isochrone
// despite trains running.
//
// This module asks plan() for each rail station in a reasonable bbox
// around the origin, using a large search window so a single call
// covers the whole "best-case" day. plan uses timetableView by default
// (per the MOTIS docs), so the returned itinerary is the fastest start-
// time-optimized journey.

import type { PlanResponse } from "@motis-project/motis-client";
import { plan } from "@/lib/motis";

// Tighter reach ceiling keeps us from probing every RR station in PA.
// 45 km/h × 30 min ≈ 22km radius — enough for SEPTA's suburban reach.
const REACH_CEIL_KMH = 45;

const M_PER_DEG_LAT = 111_320;
function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

type MapStop = {
  name: string;
  stopId: string;
  lat: number;
  lon: number;
  modes?: string[];
};

export type RailAnchor = {
  lat: number;
  lon: number;
  reachedAtMinutes: number;
  name: string;
  stopId: string;
};

async function fetchRailStopsInBbox(
  motisUrl: string,
  origin: { lat: number; lon: number },
  maxMinutes: number,
): Promise<MapStop[]> {
  // Reach ceiling: 55 km/h × budget. MOTIS's /map/stops has a "too
  // many items" cap, so we tile the bbox into quadrants if needed and
  // merge — large (60-min, metro-wide) bboxes otherwise return 422.
  const reachM = (REACH_CEIL_KMH * 1000 * maxMinutes) / 60;
  const mPerLat = M_PER_DEG_LAT;
  const mPerLon = metersPerDegLon(origin.lat);
  const minLat = origin.lat - reachM / mPerLat;
  const maxLat = origin.lat + reachM / mPerLat;
  const minLon = origin.lon - reachM / mPerLon;
  const maxLon = origin.lon + reachM / mPerLon;

  async function fetchBox(a: number, b: number, c: number, d: number): Promise<MapStop[]> {
    const q = new URLSearchParams({
      min: `${a.toFixed(5)},${c.toFixed(5)}`,
      max: `${b.toFixed(5)},${d.toFixed(5)}`,
    });
    const res = await fetch(`${motisUrl}/api/v1/map/stops?${q}`);
    if (res.status === 422) {
      // Split into 4 quadrants and recurse.
      const midLat = (a + b) / 2;
      const midLon = (c + d) / 2;
      const [q1, q2, q3, q4] = await Promise.all([
        fetchBox(a, midLat, c, midLon),
        fetchBox(a, midLat, midLon, d),
        fetchBox(midLat, b, c, midLon),
        fetchBox(midLat, b, midLon, d),
      ]);
      return [...q1, ...q2, ...q3, ...q4];
    }
    if (!res.ok) return [];
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr)) return [];
    return (arr as MapStop[]).filter((s) => (s.modes ?? []).includes("REGIONAL_RAIL"));
  }

  const all = await fetchBox(minLat, maxLat, minLon, maxLon);
  // Dedupe by stopId (tile overlap shouldn't happen but defensive).
  const seen = new Set<string>();
  const out: MapStop[] = [];
  for (const s of all) {
    if (seen.has(s.stopId)) continue;
    seen.add(s.stopId);
    out.push(s);
  }
  return out;
}

// For each rail station in bbox, ask plan() for the fastest itinerary.
// searchWindow is sized to cover the user's "best-case over window"
// intent: plan optimizes the departure moment within that window and
// returns a single best duration.
export async function probeRailReach(args: {
  origin: { lat: number; lon: number };
  maxMinutes: number;
  time: string;
  /**
   * Seconds of search-window passed to plan. 15 minutes (default 900)
   * is enough for a single-time query; bump to the full day for
   * best-case scans so one call per station covers every departure.
   */
  searchWindowSec?: number;
  motisUrl: string;
  concurrency?: number;
}): Promise<RailAnchor[]> {
  const { origin, maxMinutes, time, motisUrl } = args;
  const searchWindow = args.searchWindowSec ?? 900;
  // MOTIS handles many parallel plan queries well on its thread pool.
  // 32 parallel probes against localhost MOTIS keeps each rail station
  // probe under ~1s wall-clock even with the full-day searchWindow.
  const concurrency = args.concurrency ?? 32;

  const rail = await fetchRailStopsInBbox(motisUrl, origin, maxMinutes);
  if (rail.length === 0) return [];

  const anchors: RailAnchor[] = [];
  await parallelWithLimit(rail, concurrency, async (stop) => {
    const { data, error } = await plan({
      query: {
        fromPlace: `${origin.lat},${origin.lon}`,
        toPlace: stop.stopId,
        time,
        arriveBy: false,
        transitModes: ["TRANSIT"],
        preTransitModes: ["WALK"],
        postTransitModes: ["WALK"],
        useRoutedTransfers: true,
        maxTransfers: 3,
        timetableView: true,
        searchWindow,
        // Direct walk to a rail station past ~15 min is rarely the
        // fastest option and just inflates plan runtime; keep bounded.
        maxDirectTime: 15 * 60,
        // Leave detailed legs off — we only need the duration.
        detailedLegs: false,
      },
    });
    if (error) return;
    const body = data as PlanResponse | undefined;
    const itins = body?.itineraries ?? [];
    if (itins.length === 0) return;
    // Plan returns itineraries sorted by startTime, NOT duration —
    // with timetableView + a big searchWindow you get every valid
    // start across the window. Pick the minimum-duration itinerary
    // that actually rides Regional Rail, since a faster all-bus
    // option doesn't help us fill in rail coverage.
    let best: { duration: number } | null = null;
    for (const it of itins) {
      const usesRail = it.legs.some((l) => l.mode === "REGIONAL_RAIL");
      if (!usesRail) continue;
      if (!best || it.duration < best.duration) best = it;
    }
    if (!best) return;
    const minutes = best.duration / 60;
    if (minutes > maxMinutes) return;
    anchors.push({
      lat: stop.lat,
      lon: stop.lon,
      reachedAtMinutes: minutes,
      name: stop.name,
      stopId: stop.stopId,
    });
  });
  return anchors;
}

async function parallelWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
