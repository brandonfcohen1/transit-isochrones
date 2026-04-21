"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, MultiPolygon, Polygon } from "geojson";

type StopMode = "rail" | "subway" | "tram" | "bus" | "other";
type SlimStop = { id: string; lat: number; lon: number; d: number; m: StopMode };
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

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const clickRef = useRef<{ lng: number; lat: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopCount, setStopCount] = useState<number | null>(null);
  const [modeCounts, setModeCounts] = useState<Record<StopMode, number> | null>(null);
  // Start empty so SSR and first client render match; set to "now" after mount.
  const [departure, setDeparture] = useState<string>("");
  const [bestCase, setBestCase] = useState(false);
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);

  useEffect(() => {
    setDeparture(nowLocalInputValue());
  }, []);

  // Always-current snapshot of the query params for the click handler.
  const queryRef = useRef({ departure, bestCase, minutes });
  queryRef.current = { departure, bestCase, minutes };

  async function runQuery(lat: number, lng: number) {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) markerRef.current.remove();
    markerRef.current = new maplibregl.Marker({ color: "#1d4ed8" })
      .setLngLat([lng, lat])
      .addTo(map);

    setLoading(true);
    setStopCount(null);
    try {
      const { departure, bestCase, minutes } = queryRef.current;
      if (!departure) return;
      const time = new Date(departure).toISOString();
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        minutes: String(minutes),
        time,
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
        properties: { duration: s.d, id: s.id, mode: s.m },
      }));
      stopsSrc?.setData({ type: "FeatureCollection", features });
      setStopCount(features.length);
      const counts: Record<StopMode, number> = { rail: 0, subway: 0, tram: 0, bus: 0, other: 0 };
      for (const s of data.stops) counts[s.m]++;
      setModeCounts(counts);
    } finally {
      setLoading(false);
    }
  }

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
        id: "stops-tram",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "mode"], "tram"],
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
    });

    map.on("click", (e) => {
      clickRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      runQuery(e.lngLat.lat, e.lngLat.lng);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Re-run the last query when departure/bestCase changes, so toggling the UI
  // updates the visible isochrone without the user having to re-click.
  useEffect(() => {
    if (clickRef.current) runQuery(clickRef.current.lat, clickRef.current.lng);
  }, [departure, bestCase, minutes]);

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
          <input
            type="checkbox"
            checked={bestCase}
            onChange={(e) => setBestCase(e.target.checked)}
          />
          <span>Best-case time (scan full day)</span>
        </label>
      </div>
      {(loading || stopCount !== null) && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-md bg-white/95 px-3 py-2 text-xs shadow dark:bg-neutral-900/95">
          <div>{loading ? "Computing…" : `${stopCount} reachable stops in ${minutes} min`}</div>
          {!loading && modeCounts && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
              <ModeSwatch color="#7c3aed" label="rail" n={modeCounts.rail} />
              <ModeSwatch color="#f97316" label="subway" n={modeCounts.subway} />
              <ModeSwatch color="#10b981" label="trolley" n={modeCounts.tram} />
              <ModeSwatch color="#9ca3af" label="bus" n={modeCounts.bus + modeCounts.other} />
            </div>
          )}
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
