import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite bundles WASM + filesystem assets that Next's server bundling
  // doesn't resolve cleanly; `postgres` is native-Node-oriented too. Both
  // need to be loaded via plain Node `require` instead of being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],

  // FR-13.3 (encrypted transport) is a hosting-level concern (TLS
  // terminates in front of the app, e.g. at the platform's edge) rather
  // than something the app configures directly; these headers cover what
  // the app itself is responsible for. HSTS is added here rather than
  // left to the host, since it must be explicit or browsers won't enforce
  // it, but only takes effect once served over HTTPS.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
