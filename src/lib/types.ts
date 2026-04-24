// Shared API contract types between the server polygon engine and the
// client Map. Keep them in one file so drift is mechanical rather than
// silent duplication.

export type StreetMode = "walk" | "bike";

// Coarsest transit mode present at a reachable stop, ranked
// rail > subway > tram > bus. Drives the client's dot color + filter.
export type StopMode = "rail" | "subway" | "trolley" | "bus" | "other";

// Slim projection of a MOTIS `Reachable.all[]` entry — the minimum
// the client needs to render a dot and the polygon engine needs to
// anchor walks / size bboxes.
//   id: stop id (or lat,lon fallback)
//   d:  arrival duration in minutes (not seconds)
//   m:  coarse mode bucket
//   n:  human-readable name (optional)
export type SlimStop = {
  id: string;
  lat: number;
  lon: number;
  d: number;
  m: StopMode;
  n?: string;
};
