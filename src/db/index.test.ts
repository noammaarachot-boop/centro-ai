import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { withMigrationLock } from "./index";
import type { Database } from "./index";

// Phase 6.3 (Production Hardening) — migration concurrency safety. PGlite
// is a single embedded connection, not a real connection pool, so it can't
// genuinely prove two concurrent migration runs serialize against each
// other (the same limitation noted throughout this codebase's other
// advisory-lock tests, e.g. cron/tick/route.test.ts). What this proves
// instead, against a real Postgres (WASM) session: the lock/unlock SQL
// calls themselves succeed without error, the wrapped function actually
// runs while the lock is held, and — the property that actually matters
// for a migration script that might throw — the lock is released even
// when the wrapped function rejects, never left held forever.

let db: Database;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

async function heldAdvisoryLockCount(): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`select count(*) from pg_locks where locktype = 'advisory'`);
  const row = Array.isArray(rows) ? rows[0] : (rows as unknown as { rows: Array<{ count: string }> }).rows?.[0];
  return Number(row?.count ?? 0);
}

describe("withMigrationLock", () => {
  it("acquires the advisory lock, runs fn, releases the lock, and returns fn's result", async () => {
    const fn = vi.fn().mockResolvedValue("migrated");

    const result = await withMigrationLock(db, fn);

    expect(result).toBe("migrated");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await heldAdvisoryLockCount()).toBe(0); // released, not left held
  });

  it("releases the lock even when fn throws — never left held after a failed migration", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("migration failed"));

    await expect(withMigrationLock(db, fn)).rejects.toThrow("migration failed");

    expect(await heldAdvisoryLockCount()).toBe(0); // the finally-release ran despite the throw
  });
});
