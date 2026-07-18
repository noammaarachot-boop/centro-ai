import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite bundles WASM + filesystem assets that Next's server bundling
  // doesn't resolve cleanly; `postgres` is native-Node-oriented too. Both
  // need to be loaded via plain Node `require` instead of being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
