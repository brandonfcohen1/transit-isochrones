"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { SlimItinerary } from "@/app/api/plan/route";

type StopMode = "rail" | "subway" | "trolley" | "bus" | "other";
type StreetMode = "walk" | "bike";
type SlimStop = { id: string; lat: number; lon: number; d: number; m: StopMode; n?: string };
type StopsOnlyResponse = {
  stops: SlimStop[];
  minutes: number;
  origin: { lat: number; lon: number };
};
type PolygonOnlyResponse = {
  polygon: FeatureCollection<Polygon | MultiPolygon> | null;
  minutes: number;
  origin: { lat: number; lon: number };
};

const PHILLY: [number, number] = [-75.1635, 39.9526];
const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 5;
// Capped at 60 min so the graph-based isochrone stays sub-~7s cold at
// ~60m/90m cells. The 75-90 min range was lovely to look at but
// the 5-10s quadratic-in-reach latency on those queries pushed the UX
// past "snappy" in a way that wasn't paying for itself.
const MAX_MINUTES = 60;

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
const BASEMAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/positron/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

type ApiError = { error: unknown };

// datetime-local inputs produce "YYYY-MM-DDTHH:MM" interpreted as local time.
// Build one from the current wall clock so the default matches what the user sees.
function nowLocalInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Best-case scan: 5am-11pm of the selected day. Times are built in the
// browser's local timezone (Philadelphia for SEPTA users) and serialized
// to UTC ISO — the server is TZ-agnostic.
const BEST_CASE_START_HOUR = 5;
const BEST_CASE_END_HOUR = 23;
// Hourly sampling (18 times). Previously 5-min (216 times) because oneToAll
// at the wrong instant missed Paoli-line stops. The server-side railProbe
// (plan() with timetableView + 14h searchWindow) now covers Regional Rail
// discovery end-to-end, so the fine-grained sampling was redundant for its
// original purpose and just inflated MOTIS fan-out. Bus/subway reach varies
// only modestly hour-to-hour, which hourly sampling captures fine.
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
  // Best-case duration (minutes) from the isochrone's `d` field when the
  // destination is a reachable stop. Non-null means "isochrone said this
  // was reachable in X min best-case." If the plan() at the user's
  // selected departure is longer, show both so the schedule gap is
  // visible instead of seeming like a bug.
  bestCaseMin?: number;
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
  // Serialized snapshot of the params that produced the current
  // isochrone; `null` means nothing has run yet. When this doesn't
  // match the live params (slider moves, mode toggles, etc.) the UI
  // surfaces a re-run affordance instead of auto-firing a compute —
  // the queries are expensive (up to ~60s on cold best-case) so we
  // trigger on explicit intent.
  const [lastRanParamKey, setLastRanParamKey] = useState<string | null>(null);
  // Two-stage loading: stops arrive fast (~100-300ms cold), polygon
  // takes several seconds. `loading` stays true while the polygon is
  // pending so the spinner keeps running; `stopsReady` flips as soon
  // as the dots render.
  const [loading, setLoading] = useState(false);
  const [stopsReady, setStopsReady] = useState(false);
  // AbortController for the in-flight polygon fetch — if the user
  // clicks a different origin, cancel the previous slow request so
  // stale data never overwrites the new query.
  const polygonAbortRef = useRef<AbortController | null>(null);
  // AbortController for the stops fetch + the plan fetch, for the same
  // stale-write reason. Stops is fast enough that overlap is rare, but
  // not impossible at cold-start or under slow networks.
  const stopsAbortRef = useRef<AbortController | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);
  // Monotonic generation counter — bumped on every new runQuery. Guards
  // against stale fetches that already passed abort (e.g. one finished
  // JSON-parsing just as a new click aborted it) from overwriting the
  // map state for the current query.
  const runGenRef = useRef(0);
  // Track the origin we last fitBounds'd to. On a re-run at the same
  // origin we leave the viewport alone so the user can zoom in without
  // being yanked out on every slider tick.
  const lastFitOriginRef = useRef<{ lat: number; lng: number } | null>(null);
  const [stopCount, setStopCount] = useState<number | null>(null);
  const [modeCounts, setModeCounts] = useState<Record<StopMode, number> | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  // Surfaced to the user via a banner. Cleared on next successful fetch
  // or after 8s so a transient error doesn't stick around once the user
  // has already moved on. Manual dismiss via the Dismiss button is
  // still available.
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!errorMsg) return;
    const t = window.setTimeout(() => setErrorMsg(null), 8000);
    return () => window.clearTimeout(t);
  }, [errorMsg]);
  // Elapsed seconds during the polygon stage, so the spinner has a
  // concrete counter instead of just a pulse. Starts when stops land,
  // clears when polygon lands.
  const [polygonElapsed, setPolygonElapsed] = useState<number>(0);
  // Start empty so SSR and first client render match; set to "now" after mount.
  const [departure, setDeparture] = useState<string>("");
  // Default ON: single-time queries only see rail stations whose
  // train happens to arrive in the exact sampled minute — most
  // suburban rail (Manayunk, Chestnut Hill, Jenkintown) misses the
  // polygon at best-case OFF. The full-day scan is only ~1-2s
  // slower on cold so it's worth making the default.
  const [bestCase, setBestCase] = useState(true);
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [streetMode, setStreetMode] = useState<StreetMode>("walk");
  // Transit mode filters (MOTIS enum tokens). Omitting any turns that
  // mode off in the server-side routing. All-on means the server picks
  // the fastest across every mode (equivalent to TRANSIT). Use as a
  // debug knob ("is Regional Rail actually reaching X?") and as a user
  // feature ("bus-only commute").
  const [busEnabled, setBusEnabled] = useState(true);
  // "Metro" is the SEPTA 2024 branding for MFL + BSL + Trolleys. One
  // toggle flips both subway and trolley on the server side.
  const [metroEnabled, setMetroEnabled] = useState(true);
  const [railEnabled, setRailEnabled] = useState(true);

  // Backend cold-start state. CF Containers (and other scale-to-zero
  // hosts) sleep MOTIS when idle; the first request wakes the container
  // and MOTIS needs ~25 s to mmap the graph. We fire /api/health on
  // mount so the wake happens *during* the user's UI exploration rather
  // than after their first Run click. Polling every 2 s is cheap and
  // becomes a no-op once MOTIS reports ready.
  const [warming, setWarming] = useState(true);

  useEffect(() => {
    setDeparture(nowLocalInputValue());
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const poll = async () => {
      if (!alive) return;
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (alive && r.ok) {
          const d = (await r.json()) as { motis?: { ok?: boolean } };
          if (d.motis?.ok) { setWarming(false); return; }
        }
      } catch { /* network or container still spinning up — keep polling */ }
      if (alive) timer = window.setTimeout(poll, 2_000);
    };
    poll();
    return () => { alive = false; if (timer != null) window.clearTimeout(timer); };
  }, []);

  // URL-hash state sync. Hash format:
  //   #LAT,LON/MIN/MODE/BEST/MODES
  // e.g. #39.9526,-75.1635/30/walk/1/BMR  (bus+metro+rail, best-case on)
  // Missing segments = keep defaults. Restored once on mount + written
  // whenever state changes, so refresh/share preserves the view. If the
  // hash includes an origin, auto-run once the `departure` default is
  // in place so the user lands on a restored polygon. Legacy S/T flags
  // (separate subway + trolley) are still accepted — either one turns
  // Metro on — so old shared links keep working.
  const hashReadRef = useRef(false);
  const pendingRestoreRef = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (hashReadRef.current) return;
    hashReadRef.current = true;
    const h = (typeof window !== "undefined" && window.location.hash.slice(1)) || "";
    if (!h) return;
    const parts = h.split("/");
    const [latLon, mStr, mode, best, modeFlags] = parts;
    if (latLon && latLon.includes(",")) {
      const [laS, loS] = latLon.split(",");
      const la = Number(laS);
      const lo = Number(loS);
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        clickRef.current = { lat: la, lng: lo };
        pendingRestoreRef.current = { lat: la, lng: lo };
      }
    }
    if (mStr) { const n = Number(mStr); if (Number.isFinite(n) && n >= MIN_MINUTES && n <= MAX_MINUTES) setMinutes(n); }
    if (mode === "walk" || mode === "bike") setStreetMode(mode);
    if (best === "1") setBestCase(true);
    if (modeFlags != null) {
      setBusEnabled(modeFlags.includes("B"));
      setMetroEnabled(
        modeFlags.includes("M") || modeFlags.includes("S") || modeFlags.includes("T"),
      );
      setRailEnabled(modeFlags.includes("R"));
    }
  }, []);

  // Write hash whenever tracked state changes. Use replaceState so we
  // don't stuff the back-button history with every slider tick.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flags = `${busEnabled ? "B" : ""}${metroEnabled ? "M" : ""}${railEnabled ? "R" : ""}`;
    const origin = clickRef.current ? `${clickRef.current.lat.toFixed(4)},${clickRef.current.lng.toFixed(4)}` : "";
    const hash = origin ? `#${origin}/${minutes}/${streetMode}/${bestCase ? 1 : 0}/${flags}` : "";
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
  }, [minutes, streetMode, bestCase, busEnabled, metroEnabled, railEnabled, lastRanParamKey]);

  // Always-current snapshot of the query params for the click handler.
  const queryRef = useRef({ departure, bestCase, minutes, streetMode, busEnabled, metroEnabled, railEnabled });
  queryRef.current = { departure, bestCase, minutes, streetMode, busEnabled, metroEnabled, railEnabled };

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
    // Cancel every in-flight fetch from the previous query. Each one
    // races to update the map; without aborts the later click can see
    // an earlier click's results land on top. The generation counter
    // below is a second layer of protection in case a fetch had
    // already resolved its body before the abort fired.
    polygonAbortRef.current?.abort();
    stopsAbortRef.current?.abort();
    planAbortRef.current?.abort();
    const myGen = ++runGenRef.current;

    setLoading(true);
    setStopsReady(false);
    setStopCount(null);
    const { departure, bestCase, minutes, streetMode, busEnabled, metroEnabled, railEnabled } = queryRef.current;
    if (!departure) { setLoading(false); return; }
    const time = new Date(departure).toISOString();
    const enabledModes: string[] = [];
    if (busEnabled) enabledModes.push("BUS");
    // "Metro" groups subway (MFL + BSL) and trolley under one toggle.
    if (metroEnabled) { enabledModes.push("SUBWAY"); enabledModes.push("TRAM"); }
    if (railEnabled) enabledModes.push("REGIONAL_RAIL");
    const allOn = enabledModes.length === 4;
    const modesKey = allOn ? "T" : [...enabledModes].sort().join("+");
    const paramKey = `${lat.toFixed(4)},${lng.toFixed(4)}|${minutes}|${streetMode}|${departure}|${bestCase ? 1 : 0}|${modesKey}`;
    const baseParams = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      minutes: String(minutes),
      time,
      mode: streetMode,
    });
    if (bestCase) {
      baseParams.set("timesCsv", bestCaseSampleTimes(departure).join(","));
    }
    if (!allOn) baseParams.set("transitModes", enabledModes.join(","));

    // Stage 1 — stops. Cold ~100-300ms. Renders dots immediately so the
    // user sees reach coverage while the polygon computes.
    const stopsParams = new URLSearchParams(baseParams);
    stopsParams.set("stopsOnly", "true");
    const stopsController = new AbortController();
    stopsAbortRef.current = stopsController;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/isochrone?${stopsParams}`, { signal: stopsController.signal });
      const data = (await res.json()) as StopsOnlyResponse | ApiError;
      // If a newer runQuery has started, drop this result silently —
      // the newer call owns the loading spinner and map state.
      if (myGen !== runGenRef.current) return;
      if (!res.ok || "error" in data) {
        console.error("stops fetch error", data);
        setErrorMsg(
          res.status === 502
            ? "Routing service is unavailable. Is MOTIS running?"
            : `Stops fetch failed (HTTP ${res.status}). Try again.`,
        );
        setLoading(false);
        return;
      }
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
      setStopsReady(true);
      // If MOTIS snapped the origin to nothing routable (typical for
      // airport grounds in bike mode, or a pin on open water / inside
      // a park), there's no isochrone to compute. Surface this so the
      // user doesn't sit staring at an empty map.
      if (features.length === 0) {
        setErrorMsg(`No transit reachable from this origin in ${streetMode} mode. Try a different point or switch walk/bike.`);
        const isoSrc = map.getSource("iso") as maplibregl.GeoJSONSource | undefined;
        isoSrc?.setData({ type: "FeatureCollection", features: [] });
        setLoading(false);
        return;
      }
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return;
      if (myGen !== runGenRef.current) return;
      console.error("stops fetch exception", e);
      setErrorMsg("Network error — is the dev server running?");
      setLoading(false);
      return;
    } finally {
      if (stopsAbortRef.current === stopsController) stopsAbortRef.current = null;
    }

    // Stage 2 — polygon. Cold ~2-5s. The oneToAll call from stage 1
    // populated the server-side LRU, so the polygon fetch starts from a
    // warm oneToAll and only pays the probe + graph cost.
    const polygonParams = new URLSearchParams(baseParams);
    polygonParams.set("polygonOnly", "true");
    const controller = new AbortController();
    polygonAbortRef.current = controller;
    const polyStart = performance.now();
    setPolygonElapsed(0);
    const elapsedTimer = window.setInterval(() => {
      setPolygonElapsed(Math.round((performance.now() - polyStart) / 1000));
    }, 200);
    try {
      const res = await fetch(`/api/isochrone?${polygonParams}`, { signal: controller.signal });
      const data = (await res.json()) as PolygonOnlyResponse | ApiError;
      if (myGen !== runGenRef.current) return;
      if (!res.ok || "error" in data) {
        console.error("polygon fetch error", data);
        setErrorMsg(
          res.status === 502
            ? "Polygon unavailable — routing service error."
            : `Polygon fetch failed (HTTP ${res.status}).`,
        );
        return;
      }
      const isoSrc = map.getSource("iso") as maplibregl.GeoJSONSource | undefined;
      // Server returns a single-feature FeatureCollection (one polygon
      // per query; earlier multi-band rendering was reverted in round
      // 9 because nested fills produced visual artifacts).
      isoSrc?.setData(data.polygon ?? { type: "FeatureCollection", features: [] });
      // Autofit on first paint for this origin only. Re-runs at the
      // same origin (slider tick, mode toggle) leave the viewport
      // alone so in-zoom exploration isn't yanked back on every tick.
      // Side padding is clamped so the fit still works on narrow
      // viewports where fixed 320px side panels don't exist anyway.
      if (data.polygon && data.polygon.features.length > 0) {
        const prev = lastFitOriginRef.current;
        const originChanged = !prev || Math.abs(prev.lat - lat) > 1e-5 || Math.abs(prev.lng - lng) > 1e-5;
        if (originChanged) {
          const bounds = new maplibregl.LngLatBounds();
          const extend = (coords: unknown): void => {
            if (Array.isArray(coords) && coords.length > 0 && typeof coords[0] === "number") {
              bounds.extend(coords as [number, number]);
              return;
            }
            if (Array.isArray(coords)) for (const c of coords) extend(c);
          };
          const outer = data.polygon.features[data.polygon.features.length - 1];
          extend((outer.geometry as { coordinates: unknown }).coordinates);
          if (!bounds.isEmpty()) {
            const w = map.getCanvas().clientWidth || 800;
            const sidePad = Math.min(320, Math.floor(w * 0.2));
            map.fitBounds(bounds, { padding: { top: 80, right: sidePad, bottom: 80, left: sidePad }, maxZoom: 13, duration: 600 });
            lastFitOriginRef.current = { lat, lng };
          }
        }
      }
      setLastRanParamKey(paramKey);
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return;
      if (myGen !== runGenRef.current) return;
      console.error("polygon fetch exception", e);
      setErrorMsg("Network error while fetching polygon.");
    } finally {
      window.clearInterval(elapsedTimer);
      // Only clear loading if we weren't superseded — otherwise the next
      // runQuery is in charge of the spinner.
      if (polygonAbortRef.current === controller) {
        setLoading(false);
        setPolygonElapsed(0);
        polygonAbortRef.current = null;
      }
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

  // What params would the next re-run use? If this doesn't match the
  // last run, the committed isochrone is stale and the UI shows a
  // Re-run affordance (the user has to ask for it — cold best-case
  // queries are 60s and we don't want to fire one per slider tick).
  const currentEnabledModes: string[] = [];
  if (busEnabled) currentEnabledModes.push("BUS");
  if (metroEnabled) { currentEnabledModes.push("SUBWAY"); currentEnabledModes.push("TRAM"); }
  if (railEnabled) currentEnabledModes.push("REGIONAL_RAIL");
  const currentModesKey = currentEnabledModes.length === 4 ? "T" : [...currentEnabledModes].sort().join("+");
  const currentParamKey = clickRef.current
    ? `${clickRef.current.lat.toFixed(4)},${clickRef.current.lng.toFixed(4)}|${minutes}|${streetMode}|${departure}|${bestCase ? 1 : 0}|${currentModesKey}`
    : null;
  const isStale = clickRef.current != null && currentParamKey !== lastRanParamKey;

  const rerunCurrent = useCallback(() => {
    if (!clickRef.current) return;
    runQuery(clickRef.current.lat, clickRef.current.lng);
  }, [runQuery]);

  // Enter key commits or re-runs. A pending origin takes priority; if
  // there's no pending pin but current params diverge from the last
  // run, Enter re-runs the committed origin. Input fields swallow
  // Enter themselves, but the tag check is defence in depth.
  useEffect(() => {
    const canActOnEnter = pendingOrigin != null || isStale;
    if (!canActOnEnter) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (pendingOrigin) commitPending();
      else rerunCurrent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingOrigin, isStale, commitPending, rerunCurrent]);

  // Fetch the fastest itinerary from origin → destination and paint its
  // legs on the map. `destination` can be a reachable-stop feature (with
  // a stopId we pass to MOTIS) or a free-lat/lon pin.
  const showRouteTo = useCallback(async (destination: { lat: number; lon: number; name: string; stopId?: string; bestCaseMin?: number }) => {
    const map = mapRef.current;
    if (!map) return;
    const origin = clickRef.current;
    if (!origin) return;

    const { departure, streetMode, bestCase } = queryRef.current;
    if (!departure) return;

    // Best-case directions: search the full operating day (5am–11pm
    // local) so the chosen itinerary matches the polygon, which is also
    // a best-across-the-day reach. Without this, the plan locks to one
    // departure near `time` and disagrees with the polygon — e.g. picks
    // a longer walk because the closer station's next train just left.
    const datePart = departure.split("T")[0];
    const planTimeISO = bestCase && datePart
      ? new Date(`${datePart}T${String(BEST_CASE_START_HOUR).padStart(2, "0")}:00`).toISOString()
      : new Date(departure).toISOString();
    const params = new URLSearchParams({
      fromLat: String(origin.lat),
      fromLon: String(origin.lng),
      time: planTimeISO,
      mode: streetMode,
    });
    if (bestCase) {
      params.set("searchWindow", String((BEST_CASE_END_HOUR - BEST_CASE_START_HOUR) * 3600));
    }
    if (destination.stopId) params.set("toStop", destination.stopId);
    else {
      params.set("toLat", String(destination.lat));
      params.set("toLon", String(destination.lon));
    }

    planAbortRef.current?.abort();
    const planController = new AbortController();
    planAbortRef.current = planController;
    let res: Response;
    let data: {
      itineraries: SlimItinerary[];
      direct: SlimItinerary[];
      destinationName?: string;
      error?: unknown;
    };
    try {
      res = await fetch(`/api/plan?${params}`, { signal: planController.signal });
      data = await res.json();
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return;
      console.error("plan exception", e);
      setErrorMsg("Network error while fetching directions.");
      return;
    } finally {
      if (planAbortRef.current === planController) planAbortRef.current = null;
    }
    if (!res.ok || data.error) {
      console.error("plan error", data);
      setErrorMsg(
        res.status === 502
          ? "Directions unavailable — routing service error."
          : `Directions failed (HTTP ${res.status}).`,
      );
      return;
    }

    // Pick the shortest-duration option across transit + direct.
    const pool = [...data.itineraries, ...data.direct];
    if (pool.length === 0) {
      setErrorMsg("No route found to that destination.");
      return;
    }
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

    setRoute({
      destination: { name: resolvedName, lat: destination.lat, lon: destination.lon },
      itinerary: itin,
      bestCaseMin: destination.bestCaseMin,
    });
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
      // Iso fill goes on first so rail route lines render ON TOP of it.
      // Drawing routes under the 30% fill made parallel dark-blue Regional
      // Rail lines (Paoli, Cynwyd, Norristown HSL) bleed through as a
      // darker diagonal band in Haverford/Ardmore — looked like a second
      // polygon but was actually rail lines showing through the fill.
      map.addSource("iso", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "iso-fill",
        type: "fill",
        source: "iso",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.3 },
      });

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
      map.addLayer({
        id: "iso-outline",
        type: "line",
        source: "iso",
        paint: { "line-color": "#1d4ed8", "line-width": 1, "line-opacity": 0.5 },
      });

      map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      // Bus/other underneath — small, low-contrast so rail/subway read
      // clearly on top. Hidden at low zoom (whole-city view) because
      // 4000+ bus stops form dense grid-pattern "stripes" that read as
      // weird shading inside the isochrone. At zoom ≥12 each stop is
      // ~60m of screen space and reads as distinct.
      map.addLayer({
        id: "stops-bus",
        type: "circle",
        source: "stops",
        minzoom: 12,
        filter: ["match", ["get", "mode"], ["bus", "other"], true, false],
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            12, 1.5,
            15, 3,
          ],
          "circle-color": "#9ca3af",
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": [
            "interpolate", ["linear"], ["zoom"],
            12, 0.4,
            14, 0.75,
          ],
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
      const bestCaseMin = typeof f.properties?.duration === "number" ? f.properties.duration : undefined;
      showRouteTo({ lat, lon, name: stopName, stopId, bestCaseMin });
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

  // Auto-run when a URL hash restored an origin. Waits for both the
  // map to be ready and `departure` (set after mount) to be populated,
  // otherwise queryRef would have a stale empty departure.
  useEffect(() => {
    if (!departure) return;
    const pending = pendingRestoreRef.current;
    if (!pending || !mapRef.current) return;
    pendingRestoreRef.current = null;
    runQuery(pending.lat, pending.lng);
  }, [departure, runQuery]);

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
          <span>
            Scan full day <span className="text-neutral-400">(best train within hourly window)</span>
          </span>
        </label>
        <div className="flex items-start gap-2">
          <span className="text-neutral-500">Transit</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <ModeCheckbox color="#9ca3af" label="Bus" checked={busEnabled} onChange={setBusEnabled} />
            <ModeCheckbox color="#f97316" label="Metro" checked={metroEnabled} onChange={setMetroEnabled} />
            <ModeCheckbox color="#7c3aed" label="Regional Rail" checked={railEnabled} onChange={setRailEnabled} />
          </div>
        </div>
        <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
          Click map to stage an origin · Run to compute · Click a stop or inside the area for routes
        </div>
        {pendingOrigin ? (
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
        ) : isStale ? (
          <div className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 dark:border-amber-700 dark:bg-amber-900/30">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            <span className="flex-1 text-[11px] text-amber-900 dark:text-amber-200">
              Params changed — isochrone is stale
            </span>
            <button
              type="button"
              onClick={rerunCurrent}
              disabled={loading}
              className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Re-run ↵
            </button>
          </div>
        ) : null}
      </div>
      {errorMsg && (
        <div className="absolute top-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 shadow dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="ml-2 rounded px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900"
          >
            Dismiss
          </button>
        </div>
      )}
      {warming && !errorMsg && (
        <div className="absolute top-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <span>Warming up the routing engine — first query will be ready in ~30 s.</span>
        </div>
      )}
      {(loading || stopCount !== null) && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-md bg-white/95 px-3 py-2 text-xs shadow dark:bg-neutral-900/95">
          <div>
            {loading && !stopsReady ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                Finding reachable stops…
              </span>
            ) : loading && stopsReady ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                {stopCount} stops · computing polygon… {polygonElapsed > 0 && <span className="font-mono text-[10px] text-neutral-500">{polygonElapsed}s</span>}
              </span>
            ) : (
              `${stopCount} reachable stops in ${minutes} min`
            )}
          </div>
          {!loading && modeCounts && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-600 dark:text-neutral-300">
              <ModeSwatch color="#7c3aed" label="regional rail" n={modeCounts.rail} />
              <ModeSwatch color="#f97316" label="metro" n={modeCounts.subway + modeCounts.trolley} />
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
              {route.bestCaseMin != null && Math.round(route.itinerary.duration / 60) > route.bestCaseMin && (
                <div className="mt-0.5 text-[11px] text-neutral-500">
                  <span className="text-emerald-600 dark:text-emerald-400">{route.bestCaseMin} min best-case</span>
                  <span className="ml-1 text-neutral-400">with a better-timed departure</span>
                </div>
              )}
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

function ModeCheckbox({ color, label, checked, onChange }: { color: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </label>
  );
}
