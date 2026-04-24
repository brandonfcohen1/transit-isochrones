import { NextResponse } from "next/server";
import { cacheStats } from "@/lib/cache";

// Health probe. Deploy platforms (Render, Kubernetes, ELB) hit this to
// decide whether the instance should take traffic. Keep the check
// cheap: a fetch of MOTIS's root that times out fast. MOTIS's root
// 404s when up (no route handler at `/`), so anything non-5xx that
// arrives is "MOTIS is responding".
const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8080";

export async function GET() {
  const started = Date.now();
  let motisOk = false;
  let motisStatus = 0;
  try {
    const res = await fetch(MOTIS_URL, { signal: AbortSignal.timeout(2_000) });
    motisStatus = res.status;
    // MOTIS returning any HTTP status at all means the process is up.
    // 5xx is suspicious; 2xx/3xx/4xx are fine (no root handler → 404
    // is expected).
    motisOk = res.status < 500;
  } catch {
    motisOk = false;
  }
  const body = {
    ok: motisOk,
    motis: { ok: motisOk, status: motisStatus },
    caches: { ...cacheStats },
    uptimeSec: Math.round(process.uptime?.() ?? 0),
    probeMs: Date.now() - started,
  };
  return NextResponse.json(body, {
    status: motisOk ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
