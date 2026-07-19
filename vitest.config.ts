import { defineConfig } from "vitest/config";
import path from "node:path";

// Minimal config: unit tests only (src/lib/**), no React/DOM rendering
// needed, so no jsdom/plugin dependency beyond vitest itself — matches
// this project's "zero unnecessary dependencies" convention (see
// src/lib/csv.ts's hand-written parser for the same reasoning).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
