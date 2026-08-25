import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { buildSnapshot, SNAPSHOT_PATH } from "./pgliteSnapshot";

/**
 * Builds the migrated PGlite image once, before any worker starts.
 *
 * Runs in vitest's main process, so there is no race between workers over
 * who writes the file. See pgliteSnapshot.ts for why this exists.
 */
export async function setup() {
  const bytes = await buildSnapshot();
  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  // Write-then-rename: a reader can never observe a half-written file, so
  // an interrupted run leaves either the old snapshot or none — never a
  // truncated one that would fail deep inside an unrelated test.
  const temp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  await writeFile(temp, new Uint8Array(bytes));
  await rename(temp, SNAPSHOT_PATH);
}

export async function teardown() {
  await rm(SNAPSHOT_PATH, { force: true });
}
