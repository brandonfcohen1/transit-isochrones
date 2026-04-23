// Single process-wide concurrency limiter for MOTIS calls.
//
// Each function that talks to MOTIS used to carry its own ad-hoc limit
// (64 for oneToAll fan-out, 16 for intermodal, 32 for railProbe, 8 for
// anchor-walk, 4 for streetGrid). Under a single request those limits
// sum to >120 inflight requests against one MOTIS instance — but MOTIS
// runs a fixed-size thread pool, so beyond the pool size new requests
// queue at the server with zero throughput gain and cross-site limits
// just fight each other for head-of-line slots.
//
// A single semaphore wrapping every MOTIS entrypoint makes the cap
// honest and lets us tune one knob. `MOTIS_CONCURRENCY` env var
// overrides; default 32 is comfortable for a localhost docker MOTIS
// with 8-16 routing threads (some headroom for I/O-bound time).
const LIMIT = Number(process.env.MOTIS_CONCURRENCY ?? 32);

let inflight = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inflight < LIMIT) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}

function release(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

export async function withMotis<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// Helper for the common "run N items through an async fn, bounded by
// the global limiter" pattern. Unlike the per-caller parallelWithLimit
// copies that sprinkle the codebase, this one respects the shared cap.
export async function mapMotis<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return Promise.all(items.map((item) => withMotis(() => fn(item))));
}
