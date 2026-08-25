import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * A migrated, empty PGlite database — without paying to build one.
 *
 * Fifty-seven test files each used to do the same two things: boot a fresh
 * PGlite (which runs initdb, ~1.2s) and replay all 74 migrations (~1.1s).
 * That is ~2.4s of pure CPU per file, and vitest runs files in parallel
 * across one worker per core, so the whole suite opened with every core
 * saturated by the same redundant work. It is what made the suite flaky
 * rather than merely slow: under that load individual tests inflated 4-26x
 * over their isolated runtime and crossed their timeouts. Two did, at the
 * exact moment the machine was busiest.
 *
 * The migrated state is identical for every file, so it is built once per
 * run (see globalSetup.ts) and every database is restored from that
 * snapshot instead — measured at ~230ms against ~2350ms, and it skips
 * initdb entirely because loading a data directory replaces it.
 *
 * Isolation is unchanged. Each caller still gets its own PGlite instance
 * with its own storage; they share a starting image, never live state.
 */

export const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "node_modules",
  ".cache",
  "centro-pglite",
  "migrated.tar"
);

/** Cached per worker process — the file is read once, then reused. */
let cachedSnapshot: ArrayBuffer | null = null;

/** Builds the migrated image. Used by globalSetup, and by the fallback. */
export async function buildSnapshot(): Promise<ArrayBuffer> {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: "./drizzle" });
  const dump = await client.dumpDataDir("none");
  const bytes = await dump.arrayBuffer();
  await client.close();
  return bytes;
}

/**
 * A fresh, fully migrated PGlite instance.
 *
 * Falls back to migrating in-process if the snapshot is missing — running a
 * single file through an editor's test runner should not depend on
 * globalSetup having run. The warning is deliberate: silently falling back
 * would hide a broken globalSetup and quietly reintroduce the load spike
 * this exists to remove.
 */
export async function createMigratedPglite(): Promise<PGlite> {
  if (!cachedSnapshot) {
    if (existsSync(SNAPSHOT_PATH)) {
      const file = readFileSync(SNAPSHOT_PATH);
      cachedSnapshot = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    } else {
      console.warn(
        `[pglite] no migrated snapshot at ${SNAPSHOT_PATH} — migrating in-process. ` +
          `Expected when running one file outside \`vitest run\`; unexpected otherwise.`
      );
      cachedSnapshot = await buildSnapshot();
    }
  }
  // A new Blob per call: PGlite takes ownership of what it is handed, and
  // the cached bytes must stay reusable for the next database.
  const client = new PGlite({ loadDataDir: new Blob([cachedSnapshot]) });
  // PGlite starts its engine lazily, on the first query rather than in the
  // constructor, so without this the restore is billed to whichever test
  // queries first — inside that test's own budget instead of the caller's
  // setup hook. src/db/index.test.ts hit exactly that and worked around it
  // locally with a warm-up query; doing it here means no caller has to.
  await client.waitReady;
  return client;
}
