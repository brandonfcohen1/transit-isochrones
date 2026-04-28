import { NextResponse } from "next/server";
import type { Itinerary, Leg, Mode, PlanResponse } from "@motis-project/motis-client";
import { plan, reverseGeocode, motisTimeoutSignal } from "@/lib/motis";
import { decodePolyline } from "@/lib/polyline";
import { rateLimit } from "@/lib/rateLimit";

// Slim leg shape — client needs geometry + enough to color/label the segment.
type SlimLeg = {
  mode: string;
  duration: number;
  distance?: number;
  from: { name: string; lat: number; lon: number; time?: string };
  to: { name: string; lat: number; lon: number; time?: string };
  headsign?: string;
  routeShortName?: string;
  routeLongName?: string;
  routeColor?: string;
  coords: [number, number][];
};

type SlimItinerary = {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: SlimLeg[];
};

// MOTIS sometimes returns a transit leg's polyline as the *whole train's* route
// shape with the boarding-stop coord prepended at index 0 — so a Suburban→Eastwick
// leg on a Warminster-through-Airport train arrives with a 3 km Suburban→Temple
// jump glued on the front, then the train's actual path. Drawn raw, that's the
// "diagonal that's not a track" — it ghost-routes you to Temple and back before
// the real journey starts.
//
// Trim: find the last occurrence of leg.from in the polyline (within 300 m and
// with a continuous neighbor) before the closest match for leg.to, and slice.
// Walk/bike legs are routed point-to-point and don't need trimming.
function trimLegGeometry(
  coords: [number, number][],
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): [number, number][] {
  if (coords.length < 2) return coords;
  const sqMeters = (i: number, lat: number, lon: number) => {
    const dx = (coords[i][0] - lon) * 85_000;
    const dy = (coords[i][1] - lat) * 111_000;
    return dx * dx + dy * dy;
  };

  let toIdx = 0;
  let toBest = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = sqMeters(i, to.lat, to.lon);
    if (d < toBest) {
      toBest = d;
      toIdx = i;
    }
  }
  if (toIdx === 0) return coords;

  const TOL_M2 = 300 * 300;
  const ADJ_M2 = 500 * 500;
  let fromIdx = -1;
  for (let i = toIdx - 1; i >= 0; i--) {
    if (sqMeters(i, from.lat, from.lon) > TOL_M2) continue;
    if (i + 1 < coords.length) {
      const dx = (coords[i + 1][0] - coords[i][0]) * 85_000;
      const dy = (coords[i + 1][1] - coords[i][1]) * 111_000;
      if (dx * dx + dy * dy > ADJ_M2) continue; // discontinuous → ghost prefix
    }
    fromIdx = i;
    break;
  }
  if (fromIdx === -1) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < toIdx; i++) {
      const d = sqMeters(i, from.lat, from.lon);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    fromIdx = best;
  }
  if (fromIdx >= toIdx) return coords;
  return coords.slice(fromIdx, toIdx + 1);
}

function slimLeg(leg: Leg): SlimLeg {
  const rawCoords = leg.legGeometry?.points
    ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 7)
    : [];
  const isStreet = leg.mode === "WALK" || leg.mode === "BIKE";
  const coords = isStreet ? rawCoords : trimLegGeometry(rawCoords, leg.from, leg.to);
  return {
    mode: leg.mode,
    duration: leg.duration,
    distance: leg.distance,
    from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon, time: leg.from.departure ?? leg.from.arrival },
    to: { name: leg.to.name, lat: leg.to.lat, lon: leg.to.lon, time: leg.to.arrival ?? leg.to.departure },
    headsign: leg.headsign,
    routeShortName: leg.routeShortName,
    routeLongName: leg.routeLongName,
    routeColor: leg.routeColor,
    coords,
  };
}

function slimItinerary(it: Itinerary): SlimItinerary {
  return {
    duration: it.duration,
    startTime: it.startTime,
    endTime: it.endTime,
    transfers: it.transfers,
    legs: it.legs.map(slimLeg),
  };
}

// GET /api/plan?fromLat=..&fromLon=..&toLat=..&toLon=..&time=<iso>&mode=walk|bike
//   &toStop=<stopId> (optional — pass a stop id instead of toLat/toLon)
//
// Returns { itineraries: SlimItinerary[], direct: SlimItinerary[] }.
// Itineraries include full leg geometry (decoded polyline → [lon,lat] coords)
// so the client can draw them as GeoJSON without further processing.
// Keep in sync with isochrone/route.ts and data/septa-region.osm.pbf's bbox.
function inCoverage(lat: number, lon: number): boolean {
  return lat >= 39.55 && lat <= 40.45 && lon >= -76.0 && lon <= -74.65;
}

export async function GET(req: Request) {
  // Higher cap than /api/isochrone — clicking destinations inside an
  // existing polygon is a more common interaction and each call is
  // cheap (no fan-out, one plan).
  const rl = rateLimit(req, { capacity: 60, refillPerSec: 1 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }
  const url = new URL(req.url);
  const fromLat = Number(url.searchParams.get("fromLat"));
  const fromLon = Number(url.searchParams.get("fromLon"));
  const toLat = Number(url.searchParams.get("toLat"));
  const toLon = Number(url.searchParams.get("toLon"));
  const toStop = url.searchParams.get("toStop");
  const time = url.searchParams.get("time") ?? new Date().toISOString();
  const modeParam = url.searchParams.get("mode");
  const mode: "walk" | "bike" = modeParam === "bike" ? "bike" : "walk";
  // Optional best-case search: when on, MOTIS scans a wide departure
  // window (default 24h) instead of its 15-min default. Without this the
  // route is locked to whichever single train is closest to `time`, so
  // it can disagree with the polygon — the polygon samples the whole
  // operating day for stop reach, but a "now" plan picks one departure.
  // The client sends `time` = local 5am of the selected date when
  // best-case is on, so the window covers 5am–5am.
  const searchWindowRaw = Number(url.searchParams.get("searchWindow"));
  const searchWindow = Number.isFinite(searchWindowRaw) && searchWindowRaw > 0
    ? Math.min(searchWindowRaw, 24 * 3600)
    : undefined;

  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLon)) {
    return NextResponse.json({ error: "fromLat/fromLon required" }, { status: 400 });
  }
  if (!inCoverage(fromLat, fromLon)) {
    return NextResponse.json({ error: "origin outside coverage area" }, { status: 400 });
  }
  if (!toStop && (!Number.isFinite(toLat) || !Number.isFinite(toLon))) {
    return NextResponse.json({ error: "toLat/toLon or toStop required" }, { status: 400 });
  }
  if (!toStop && !inCoverage(toLat, toLon)) {
    return NextResponse.json({ error: "destination outside coverage area" }, { status: 400 });
  }

  // Non-transit modes for first/last mile. For bike, MOTIS will route on
  // bike-friendly OSM ways; for walk, on pedestrian ways.
  const streetMode: Mode = mode === "bike" ? "BIKE" : "WALK";

  const fromPlace = `${fromLat},${fromLon}`;
  const toPlace = toStop ?? `${toLat},${toLon}`;

  // Plan + (for free-coord destinations) reverse-geocode in parallel —
  // MOTIS labels unknown coords as "END" in the itinerary, so we patch
  // the client-facing name with the closest named place.
  const planPromise = plan({
    signal: motisTimeoutSignal(),
    query: {
      fromPlace,
      toPlace,
      time,
      arriveBy: false,
      transitModes: ["TRANSIT"],
      preTransitModes: [streetMode],
      postTransitModes: [streetMode],
      directModes: [streetMode],
      detailedLegs: true,
      detailedTransfers: true,
      useRoutedTransfers: true,
      maxTransfers: 3,
      // Transfer-quality knobs (minutes — MOTIS API is min, not sec).
      // Without these, MOTIS minimizes wall-clock only and a 1-min bus
      // that catches a slightly earlier train wins by ~1–2 min over a
      // straight walk-to-rail with 0 transfers (observed: 1380s w/ BUS 33
      // → 1m walk → AIR vs. 1500s direct walk → AIR). 2-min additional
      // transfer time penalizes each interchange enough that a sub-2-min
      // bus shortcut has to actually beat the walk by >2 min, while
      // 2-min minTransferTime adds realistic platform slack so MOTIS
      // stops planning 0-min-wait bus boards.
      additionalTransferTime: 2,
      minTransferTime: 2,
      // timetableView is required for searchWindow to fan out across the
      // day; without it MOTIS picks one Pareto-optimal answer near `time`
      // and ignores the rest of the window. Off when no window override
      // (matches the previous behavior so a normal "leave now" plan stays
      // single-departure cheap).
      timetableView: searchWindow != null,
      // Give direct non-transit up to ~60min so bike/walk-only for short
      // trips shows up even when a transit option exists.
      maxDirectTime: 60 * 60,
      ...(searchWindow != null ? { searchWindow, numItineraries: 20 } : {}),
    },
  });
  const reverseGeocodePromise: Promise<string | undefined> = toStop
    ? Promise.resolve(undefined)
    : reverseGeocode({ signal: motisTimeoutSignal(), query: { place: `${toLat},${toLon}` } })
        .then((r) => {
          const hits = r.data as Array<{ name?: string }> | undefined;
          return hits?.[0]?.name;
        })
        .catch(() => undefined);

  const [planRes, destName] = await Promise.all([planPromise, reverseGeocodePromise]);
  if (planRes.error) {
    console.error("plan error", planRes.error);
    return NextResponse.json({ error: "routing service error" }, { status: 502 });
  }
  const body = planRes.data as PlanResponse;
  return NextResponse.json(
    {
      itineraries: (body.itineraries ?? []).map(slimItinerary),
      direct: (body.direct ?? []).map(slimItinerary),
      destinationName: destName,
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}

export type { SlimItinerary, SlimLeg };
