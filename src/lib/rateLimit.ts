// Per-IP token-bucket rate limit.
//
// In-process state — good for a single Node instance. If this app ever
// runs multi-replica, replace `buckets` with a Redis-backed store so
// each replica sees a consistent view. The token-bucket math is the
// same; only the storage changes.
//
// Capacity = max burst a single IP can send. Refill = long-run rate.
// Numbers are picked so normal interactive use (click + slider tweak +
// re-run) sits comfortably inside the budget, but a scripted attacker
// can't open the DoS window the coverage/timesCsv caps close.
import { LRU } from "./cache";

type Bucket = { tokens: number; lastRefillMs: number };

// 10k IPs is way more than a single-instance SEPTA-area app will see at
// peak; LRU eviction handles whatever trickle of unique IPs accumulates
// over weeks of uptime.
const buckets = new LRU<string, Bucket>(10_000);

function clientIp(req: Request): string {
  // x-forwarded-for is a comma-separated list; the first entry is the
  // original client when set by a trusted proxy (Render, Cloudflare).
  // Fall back to x-real-ip (also proxy-set), then to a constant so a
  // bare dev request still maps to a bucket.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

export function rateLimit(
  req: Request,
  opts: { capacity: number; refillPerSec: number },
): RateLimitResult {
  // In dev, skip entirely. Local bench + curl probes don't set
  // x-forwarded-for so they'd all collapse into one bucket and
  // starve each other at the 30/min cap. Production deploys sit
  // behind a proxy (Render, Cloudflare) that sets x-forwarded-for.
  if (process.env.NODE_ENV !== "production") return { ok: true };
  const ip = clientIp(req);
  const now = Date.now();
  const prev = buckets.get(ip);
  const startTokens = prev ? prev.tokens : opts.capacity;
  const lastMs = prev ? prev.lastRefillMs : now;
  const elapsedSec = (now - lastMs) / 1000;
  const refilled = Math.min(opts.capacity, startTokens + elapsedSec * opts.refillPerSec);

  if (refilled < 1) {
    buckets.set(ip, { tokens: refilled, lastRefillMs: now });
    return { ok: false, retryAfter: Math.ceil((1 - refilled) / opts.refillPerSec) };
  }

  buckets.set(ip, { tokens: refilled - 1, lastRefillMs: now });
  return { ok: true };
}
