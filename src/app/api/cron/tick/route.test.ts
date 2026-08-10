import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Phase 4.1 remediation — the advisory-lock gate around runScheduledTasks,
 * so two overlapping cron ticks (a slow tick + external-scheduler jitter,
 * or a manual re-trigger) can never both act on the same due rows. No
 * prior test file existed for this route.
 *
 * PGlite is a single embedded connection, not a real connection pool, so
 * it can't genuinely run two overlapping transactions the way two real
 * concurrent Postgres sessions would (this codebase's other atomic-claim
 * tests — e.g. pendingConfirmations.ts's flushDueIntakeNotifications —
 * don't attempt true concurrent-transaction simulation either, for the
 * same reason). The real Postgres semantics of pg_try_advisory_xact_lock
 * (mutual exclusion across sessions, auto-release on transaction end) are
 * standard, well-documented Postgres behavior, not something this suite
 * re-proves; what IS this route's own code, and worth testing directly,
 * is that it correctly interprets a "lock not acquired" result and skips
 * — verified below with a lightweight mocked db.transaction.
 */

let db: Database;
// Set by the "lock already held" test only, for that one call — lets it
// simulate exactly what a concurrent second tick would observe from
// Postgres (pg_try_advisory_xact_lock returning false) without needing a
// second real overlapping PGlite transaction.
let dbOverride: unknown = null;
vi.mock("@/db", () => ({ getDb: async () => dbOverride ?? db }));

const runScheduledTasks = vi.fn();
vi.mock("@/lib/scheduler", () => ({
  runScheduledTasks: (...args: unknown[]) => runScheduledTasks(...args),
}));

const { POST } = await import("./route");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  runScheduledTasks.mockReset();
  dbOverride = null;
});

function req(): Request {
  return new Request("https://example.com/api/cron/tick", { method: "POST" });
}

describe("POST /api/cron/tick — Phase 4.1: advisory lock prevents overlapping ticks", () => {
  it("a normal single tick acquires the lock, runs, and returns ok", async () => {
    runScheduledTasks.mockResolvedValue({ evaluated: 1, reminded: 0, delivered: 0, driveRetried: 0, recurringCyclesCreated: 0, confirmationsReminded: 0, confirmationsEscalated: 0, intakeNotificationsFlushed: 0, caseStatusReviewsRun: 0 });
    const response = await POST(req());
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(runScheduledTasks).toHaveBeenCalledTimes(1);
  });

  it("two ticks run one after another (the lock from the first is fully released by the time it responds) — both succeed, never skipped", async () => {
    runScheduledTasks.mockResolvedValue({ evaluated: 0, reminded: 0, delivered: 0, driveRetried: 0, recurringCyclesCreated: 0, confirmationsReminded: 0, confirmationsEscalated: 0, intakeNotificationsFlushed: 0, caseStatusReviewsRun: 0 });
    const first = await POST(req());
    const second = await POST(req());
    expect((await first.json()).status).toBe("ok");
    expect((await second.json()).status).toBe("ok");
    expect(runScheduledTasks).toHaveBeenCalledTimes(2);
  });

  it("when the advisory-lock check reports the lock is already held, the route skips cleanly — never calls runScheduledTasks, never throws", async () => {
    dbOverride = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        const fakeTx = { execute: async () => [{ locked: false }] };
        return callback(fakeTx);
      },
      insert: () => ({ values: async () => {} }),
    };

    const response = await POST(req());
    const body = await response.json();
    expect(body).toEqual({ status: "skipped", reason: "already_running" });
    expect(runScheduledTasks).not.toHaveBeenCalled();
  });
});
