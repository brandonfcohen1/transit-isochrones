import type { NextConfig } from "next";

// Security headers applied to every response.
//
// CSP is deliberately loose on scripts: Next.js ships inline bootstrap
// scripts and the runtime uses eval-like constructs in dev. Tightening
// to nonce-based CSP requires middleware and is a follow-up; the
// current policy covers the routine XSS / clickjacking vectors without
// breaking next/font, MapLibre, or the basemap providers we use.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // api.maptiler.com serves the style.json; *.maptiler.com serves tiles;
  // demotiles.maplibre.org is the no-key fallback basemap.
  "connect-src 'self' https://api.maptiler.com https://*.maptiler.com https://demotiles.maplibre.org",
  // MapLibre's worker is loaded from a blob: URL.
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
  // Legacy header for old browsers; modern ones honor frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  // Self-contained runtime bundle: writes .next/standalone with a
  // minimal server.js + only the node_modules actually imported.
  // Drops ~200MB off the Docker image vs shipping the full
  // node_modules tree, and makes the deploy one-file.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
