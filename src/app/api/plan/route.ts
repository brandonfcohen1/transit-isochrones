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

function slimLeg(leg: Leg): SlimLeg {
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
    coords: leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 7) : [],
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
function inCoverage(lat: number, lon: number): boolean {
  return lat >= 39.3 && lat <= 40.5 && lon >= -76.0 && lon <= -74.4;
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
      timetableView: false,
      // Give direct non-transit up to ~60min so bike/walk-only for short
      // trips shows up even when a transit option exists.
      maxDirectTime: 60 * 60,
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
