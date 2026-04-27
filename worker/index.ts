// Cloudflare Worker entry point.
//
// All HTTP requests hit this Worker first; it forwards them to a single
// named container instance. Using one named instance ("default") means
// every request — page load, API call, /api/health probe — lands on
// the same container, so MOTIS stays hot once it's up. With sleepAfter
// set on the Container class, the instance scales to zero when idle.
//
// The Worker layer itself never reads request bodies or rewrites URLs;
// it's a pure pass-through. Routing logic lives in the Next.js app.

/// <reference types="@cloudflare/workers-types" />
import { Container } from "@cloudflare/containers";

export class App extends Container {
  // Next.js listens here (set in supervisord.conf via PORT=3000).
  defaultPort = 3000;
  // Idle timeout before the instance scales to zero. Picking 5m means
  // a single user's session keeps it warm across navigation; 5+ min of
  // no traffic and we shed the instance to stop billing.
  sleepAfter = "5m";
  // MOTIS needs ~25 s to mmap the graph after process start. Without a
  // bump, CF's default container readiness check fails and routes 5xx.
  // The Worker also fields the client's /api/health polling, which
  // returns 503 until MOTIS is reachable — that drives the warm-up
  // banner in the Map UI without us needing extra wiring here.
}

interface Env {
  APP: DurableObjectNamespace<App>;
}

const handler: ExportedHandler<Env> = {
  async fetch(req, env) {
    return env.APP.getByName("default").fetch(req);
  },
};

export default handler;
