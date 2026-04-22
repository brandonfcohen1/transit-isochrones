"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { SlimItinerary } from "@/app/api/plan/route";

type StopMode = "rail" | "subway" | "trolley" | "bus" | "other";
type StreetMode = "walk" | "bike";
type SlimStop = { id: string; lat: number; lon: number; d: number; m: StopMode; n?: string };
type IsochroneEnvelope = {
  polygon: Feature<Polygon | MultiPolygon> | null;
  stops: SlimStop[];
  minutes: number;
  origin: { lat: number; lon: number };
};

const PHILLY: [number, number] = [-75.1635, 39.9526];
const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 5;
const MAX_MINUTES = 90;

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
const BASEMAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/positron/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

type IsochroneResponse = IsochroneEnvelope | { error: unknown };

// datetime-local inputs produce "YYYY-MM-DDTHH:MM" interpreted as local time.
// Build one from the current wall clock so the default matches what the user sees.
function nowLocalInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Best-case scan: 5am-11pm of the selected day, every 30 min. Times are built
// in the browser's local timezone (Philadelphia for SEPTA users) and serialized
// to UTC ISO — the server is TZ-agnostic.
const BEST_CASE_START_HOUR = 5;
const BEST_CASE_END_HOUR = 23;
const BEST_CASE_STEP_MIN = 60;

function bestCaseSampleTimes(departureLocal: string): string[] {
  const datePart = departureLocal.split("T")[0];
  if (!datePart) return [];
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let h = BEST_CASE_START_HOUR; h < BEST_CASE_END_HOUR; h++) {
    for (let m = 0; m < 60; m += BEST_CASE_STEP_MIN) {
      out.push(new Date(`${datePart}T${pad(h)}:${pad(m)}`).toISOString());
    }
  }
  return out;
}

type RouteInfo = {
  destination: { name: string; lat: number; lon: number };
  itinerary: SlimItinerary;
};

// SEPTA nomenclature: GTFS/MOTIS emit "TRAM" for the 10/11/13/15/34/36
// trolley lines, but nobody in Philly calls them trams.
function displayMode(mode: string): string {
  return mode === "TRAM" ? "TROLLEY" : mode;
}

// Line color per leg mode. Transit modes reuse the stop palette for
// consistency; walk/bike are neutrals so they don't compete visually.
function legColor(mode: string): string {
  switch (mode) {
    case "WALK": return "#6b7280";
    case "BIKE": return "#0ea5e9";
    case "BUS": return "#9ca3af";
    case "TRAM": return "#10b981"; // SEPTA trolley
    case "SUBWAY": return "#f97316";
    case "RAIL":
    case "REGIONAL_RAIL":
    case "SUBURBAN":
    case "LONG_DISTANCE":
    case "HIGHSPEED_RAIL":
    case "NIGHT_RAIL":
    case "REGIONAL_FAST_RAIL":
      return "#7c3aed";
    default: return "#4b5563";
  }
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Committed origin: the isochrone is drawn *from here*.
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const clickRef = useRef<{ lng: number; lat: number } | null>(null);
  // Pending origin: the user clicked but hasn't committed yet. Staged so
  // exploratory clicks don't spend an isochrone query per click.
  const pendingMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [pendingOrigin, setPendingOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopCount, setStopCount] = useState<number | null>(null);
  const [modeCounts, setModeCounts] = useState<Record<StopMode, number> | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  // Start empty so SSR and first client render match; set to "now" after mount.
  const [departure, setDeparture] = useState<string>("");
  const [bestCase, setBestCase] = useState(false);
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [streetMode, setStreetMode] = useState<StreetMode>("walk");

  useEffect(() => {
    setDeparture(nowLocalInputValue());
  }, []);

  // Always-current snapshot of the query params for the click handler.
  const queryRef = useRef({ departure, bestCase, minutes, streetMode });
  queryRef.current = { departure, bestCase, minutes, streetMode };

  const clearRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("itinerary") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: [] });
    destMarkerRef.current?.remove();
    destMarkerRef.current = null;
    setRoute(null);
  }, []);

  // Stage an origin without running the query. Keeps the committed blue
  // marker / current isochrone in place so the user can see both while
  // deciding whether to commit.
  const setPending = useCallback((lat: number, lng: number) => {
    const map = mapRef.current;
    if (!map) return;
    pendingMarkerRef.current?.remove();
    pendingMarkerRef.current = new maplibregl.Marker({ color: "#9ca3af", opacity: 0.85 })
      .setLngLat([lng, lat])
      .addTo(map);
    setPendingOrigin({ lat, lng });
  }, []);

  const clearPending = useCallback(() => {
    pendingMarkerRef.current?.remove();
    pendingMarkerRef.current = null;
    setPendingOrigin(null);
  }, []);

  const runQuery = useCallback(async (lat: number, lng: number) => {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) markerRef.current.remove();
    markerRef.current = new maplibregl.Marker({ color: "#1d4ed8" })
      .setLngLat([lng, lat])
      .addTo(map);

    // The origin moved — any previously rendered route is now stale.
    clearRoute();

    setLoading(true);
    setStopCount(null);
    try {
      const { departure, bestCase, minutes, streetMode } = queryRef.current;
      if (!departure) return;
      const time = new Date(departure).toISOString();
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        minutes: String(minutes),
        time,
        mode: streetMode,
      });
      if (bestCase) {
        params.set("timesCsv", bestCaseSampleTimes(departure).join(","));
      }

      const res = await fetch(`/api/isochrone?${params}`);
      const data = (await res.json()) as IsochroneResponse;
      if (!res.ok || "error" in data) {
        console.error("isochrone error", data);
        return;
      }

      const isoSrc = map.getSource("iso") as maplibregl.GeoJSONSource | undefined;
      isoSrc?.setData(
        data.polygon ? { type: "FeatureCollection", features: [data.polygon] } : { type: "FeatureCollection", features: [] },
      );

      const stopsSrc = map.getSource("stops") as maplibregl.GeoJSONSource | undefined;
      const features = data.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: { duration: s.d, id: s.id, mode: s.m, name: s.n ?? s.id },
      }));
      stopsSrc?.setData({ type: "FeatureCollection", features });
      setStopCount(features.length);
      const counts: Record<StopMode, number> = { rail: 0, subway: 0, trolley: 0, bus: 0, other: 0 };
      for (const s of data.stops) counts[s.m]++;
      setModeCounts(counts);
    } finally {
      setLoading(false);
    }
  }, [clearRoute]);

  // Confirm the pending origin: set clickRef (drives param re-runs),
  // drop the pending gray pin, and fire the isochrone. This is the only
  // path that actually spends an isochrone query from a user action.
  const commitPending = useCallback(() => {
    if (!pendingOrigin) return;
    const { lat, lng } = pendingOrigin;
    clickRef.current = { lat, lng };
    pendingMarkerRef.current?.remove();
    pendingMarkerRef.current = null;
    setPendingOrigin(null);
    runQuery(lat, lng);
  }, [pendingOrigin, runQuery]);

  // Enter key commits. Only listens when a pending origin exists so the
  // shortcut doesn't "activate" when the user is typing in the datetime
  // input (the input swallows Enter itself, but defence in depth).
  useEffect(() => {
    if (!pendingOrigin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      commitPending();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingOrigin, commitPending]);

  // Fetch the fastest itinerary from origin → destination and paint its
  // legs on the map. `destination` can be a reachable-stop feature (with
  // a stopId we pass to MOTIS) or a free-lat/lon pin.
  const showRouteTo = useCallback(async (destination: { lat: number; lon: number; name: string; stopId?: string }) => {
    const map = mapRef.current;
    if (!map) return;
    const origin = clickRef.current;
    if (!origin) return;

    const { departure, streetMode } = queryRef.current;
    if (!departure) return;

    const params = new URLSearchParams({
      fromLat: String(origin.lat),
      fromLon: String(origin.lng),
      time: new Date(departure).toISOString(),
      mode: streetMode,
    });
    if (destination.stopId) params.set("toStop", destination.stopId);
    else {
      params.set("toLat", String(destination.lat));
      params.set("toLon", String(destination.lon));
    }

    const res = await fetch(`/api/plan?${params}`);
    const data = (await res.json()) as {
      itineraries: SlimItinerary[];
      direct: SlimItinerary[];
      destinationName?: string;
      error?: unknown;
    };
    if (!res.ok || data.error) {
      console.error("plan error", data);
      return;
    }

    // Pick the shortest-duration option across transit + direct.
    const pool = [...data.itineraries, ...data.direct];
    if (pool.length === 0) return;
    const itin = pool.reduce((a, b) => (a.duration < b.duration ? a : b));
    // Prefer server-reverse-geocoded name for free-coord destinations;
    // stop clicks already pass a real stop name.
    const resolvedName = destination.stopId ? destination.name : (data.destinationName ?? destination.name);

    const features = itin.legs
      .filter((l) => l.coords.length >= 2)
      .map((l, i) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: l.coords },
        properties: {
          mode: l.mode,
          color: l.routeColor && l.routeColor.length > 0 ? `#${l.routeColor}` : legColor(l.mode),
          label: l.routeShortName ?? l.headsign ?? l.mode,
          legIndex: i,
          isTransit: l.mode !== "WALK" && l.mode !== "BIKE",
        },
      }));

    const src = map.getSource("itinerary") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features });

    destMarkerRef.current?.remove();
    destMarkerRef.current = new maplibregl.Marker({ color: "#dc2626" })
      .setLngLat([destination.lon, destination.lat])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setText(resolvedName))
      .addTo(map);

    setRoute({ destination: { name: resolvedName, lat: destination.lat, lon: destination.lon }, itinerary: itin });
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: PHILLY,
      zoom: 11,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("septa-routes", { type: "geojson", data: "/septa-routes.geojson" });
      map.addLayer({
        id: "routes-line",
        type: "line",
        source: "septa-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "route_color"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            8, 1.2,
            12, 2.5,
            16, 5,
          ],
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "routes-label",
        type: "symbol",
        source: "septa-routes",
        minzoom: 11,
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "short_name"],
          "text-size": 11,
          "text-font": ["Noto Sans Bold", "Open Sans Bold", "Arial Unicode MS Bold"],
          "symbol-spacing": 250,
        },
        paint: {
          "text-color": ["get", "route_color"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      map.addSource("iso", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "iso-fill",
        type: "fill",
        source: "iso",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.3 },
      });
      map.addLayer({
        id: "iso-outline",
        type: "line",
        source: "iso",
        paint: { "line-color": "#1d4ed8", "line-width": 1.5 },
      });

      map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      // Bus/other underneath — small, low-contrast so rail/subway read clearly on top.
      map.addLayer({
        id: "stops-bus",
        type: "circle",
        source: "stops",
        filter: ["match", ["get", "mode"], ["bus", "other"], true, false],
        paint: {
          "circle-radius": 2.5,
          "circle-color": "#9ca3af",
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.75,
        },
      });
      map.addLayer({
        id: "stops-trolley",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "mode"], "trolley"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#10b981",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "stops-subway",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "mode"], "subway"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#f97316",
          "circle-stroke-width": 1.25,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "stops-rail",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "mode"], "rail"],
        paint: {
          "circle-radius": 6,
          "circle-color": "#7c3aed",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });

      // Itinerary legs — a separate source so we can keep the stop
      // circles and isochrone fills untouched while a route is displayed.
      // Transit legs render solid; walking/biking legs dash to signal
      // "street travel, not vehicle" at a glance.
      map.addSource("itinerary", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "itinerary-casing",
        type: "line",
        source: "itinerary",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, 5,
            14, 9,
            18, 13,
          ],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "itinerary-line",
        type: "line",
        source: "itinerary",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, 3,
            14, 6,
            18, 10,
          ],
          "line-dasharray": [
            "case",
            ["get", "isTransit"], ["literal", [1, 0]],
            ["literal", [0.5, 1.5]],
          ],
        },
      });
    });

    const onStopClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      // Stop IDs come from MOTIS and can be passed straight back as `toPlace`
      // which lets MOTIS match the stop instead of snapping lat/lon.
      const geom = f.geometry as { type: string; coordinates: [number, number] };
      const [lon, lat] = geom.coordinates;
      const stopId = f.properties?.id as string | undefined;
      const stopName = (f.properties?.name as string | undefined) ?? stopId ?? "stop";
      showRouteTo({ lat, lon, name: stopName, stopId });
      e.preventDefault();
    };
    for (const layerId of ["stops-bus", "stops-trolley", "stops-subway", "stops-rail"]) {
      map.on("click", layerId, onStopClick);
      map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
    }

    // Click anywhere inside the isochrone polygon to get directions to
    // that free coord. Stop clicks win (their handler fires first and
    // preventDefault's); we preventDefault here too so the catch-all
    // below doesn't stage a pending origin.
    map.on("click", "iso-fill", (e) => {
      if (e.defaultPrevented) return;
      if (!clickRef.current) return; // no committed origin yet
      showRouteTo({ lat: e.lngLat.lat, lon: e.lngLat.lng, name: "Destination" });
      e.preventDefault();
    });
    map.on("mouseenter", "iso-fill", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "iso-fill", () => (map.getCanvas().style.cursor = ""));

    map.on("click", (e) => {
      // Stop / iso-fill clicks mark the event as defaultPrevented so
      // this handler won't reset the origin or stage a pending pin
      // whenever the user picks a destination.
      if (e.defaultPrevented) return;
      // Intentional trigger: clicking only stages a pending origin. The
      // user confirms via the Run button or Enter. This prevents an
      // isochrone query per exploratory click.
      setPending(e.lngLat.lat, e.lngLat.lng);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Map init runs exactly once — the click handlers read from queryRef
    // and useCallback refs, so we intentionally don't re-init on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run the last query when departure/bestCase/mode changes, so toggling
  // the UI updates the visible isochrone without the user having to re-click.
  useEffect(() => {
    if (clickRef.current) runQuery(clickRef.current.lat, clickRef.current.lng);
    // runQuery is stable (useCallback); we intentionally drive re-runs off
    // the input values rather than adding it to deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departure, bestCase, minutes, streetMode]);

  return (
    <>
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 rounded-lg bg-white/95 px-4 py-3 text-xs shadow-lg backdrop-blur dark:bg-neutral-900/95">
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Depart</span>
          <input
            type="datetime-local"
            value={departure}
            onChange={(e) => setDeparture(e.target.value)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-800"
          />
          <button
            type="button"
            onClick={() => setDeparture(nowLocalInputValue())}
            className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Now
          </button>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Within</span>
          <input
            type="range"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-32"
          />
          <span className="w-14 text-right font-mono tabular-nums">{minutes} min</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">First/last mile</span>
          <div className="inline-flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            {(["walk", "bike"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setStreetMode(m)}
                className={`px-2 py-1 ${streetMode === m ? "bg-blue-600 text-white" : "bg-white text-neutral-700 hover:bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"}`}
              >
                {m === "walk" ? "Walk" : "Bike"}
              </button>
            ))}
          </div>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={bestCase}
            onChange={(e) => setBestCase(e.target.checked)}
          />
          <span>Best-case time <span className="text-neutral-400">(scan full day, uses fast approximation)</span></span>
        </label>
        <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Click map to stage an origin · Run to compute · Click a stop or inside the area for routes
        </div>
        {pendingOrigin && (
          <div className="flex items-center gap-2 rounded border border-neutral-300 bg-neutral-50 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-800">
            <span className="inline-block h-2 w-2 rounded-full bg-neutral-400" />
            <span className="flex-1 font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
              {pendingOrigin.lat.toFixed(4)}, {pendingOrigin.lng.toFixed(4)}
            </span>
            <button
              type="button"
              onClick={clearPending}
              className="rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitPending}
              disabled={loading}
              className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Run ↵
            </button>
          </div>
        )}
      </div>
      {(loading || stopCount !== null) && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-md bg-white/95 px-3 py-2 text-xs shadow dark:bg-neutral-900/95">
          <div>
            {loading ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                Routing every cell through the graph… {minutes >= 60 ? "may take ~5s" : ""}
              </span>
            ) : (
              `${stopCount} reachable stops in ${minutes} min`
            )}
          </div>
          {!loading && modeCounts && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
              <ModeSwatch color="#7c3aed" label="rail" n={modeCounts.rail} />
              <ModeSwatch color="#f97316" label="subway" n={modeCounts.subway} />
              <ModeSwatch color="#10b981" label="trolley" n={modeCounts.trolley} />
              <ModeSwatch color="#9ca3af" label="bus" n={modeCounts.bus + modeCounts.other} />
            </div>
          )}
        </div>
      )}
      {route && (
        <div className="absolute top-4 right-4 z-10 w-72 rounded-lg bg-white/95 px-4 py-3 text-xs shadow-lg backdrop-blur dark:bg-neutral-900/95">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold">Route to {route.destination.name}</div>
              <div className="text-[11px] text-neutral-500">
                {Math.round(route.itinerary.duration / 60)} min · {route.itinerary.transfers} transfer{route.itinerary.transfers === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              onClick={clearRoute}
              className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Clear
            </button>
          </div>
          <ol className="flex flex-col gap-1">
            {route.itinerary.legs.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: l.routeColor ? `#${l.routeColor}` : legColor(l.mode) }}
                />
                <span className="flex-1">
                  <span className="font-mono text-[11px] uppercase text-neutral-500">{displayMode(l.mode)}</span>{" "}
                  {l.routeShortName && <span className="font-semibold">{l.routeShortName}</span>}
                  {l.headsign && <span className="text-neutral-500"> → {l.headsign}</span>}
                  <span className="ml-1 text-neutral-500">({Math.round(l.duration / 60)} min)</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function ModeSwatch({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-mono tabular-nums">{n}</span>
      <span>{label}</span>
    </span>
  );
}
