// Server-side MOTIS client. Configures the fetch client with our MOTIS base URL.
// Keep all MOTIS calls behind Route Handlers so the URL stays out of the browser.
import { client } from "@motis-project/motis-client";

const MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8080";

client.setConfig({ baseUrl: MOTIS_URL });

export * from "@motis-project/motis-client";

// Per-call timeout. MOTIS occasionally hangs under load (thread-pool
// saturation, slow disk on a fresh graph). Without a cap, call sites
// wait up to `maxDuration` on the route handler which is too long —
// a single stuck call then wedges every batch behind it. 20s is
// comfortably longer than a realistic intermodal batch (~2-3s p95)
// while still cutting off a genuine hang.
export const MOTIS_TIMEOUT_MS = Number(process.env.MOTIS_TIMEOUT_MS ?? 20_000);

export function motisTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(MOTIS_TIMEOUT_MS);
}
