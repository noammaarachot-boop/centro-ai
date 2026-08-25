import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// job_runs grows ~105,000 rows a year and nothing removed any of them.
// These cover the two properties that matter for a delete that runs
// unattended on every cron tick: it removes exactly what is past the
// window, and it removes nothing else.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { pruneOldJobRuns, JOB_RUN_RETENTION_DAYS } = await import("./jobRunRetention");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
  await db.execute(sql`select 1`);
}, 60_000);

beforeEach(async () => {
  await db.execute(sql`delete from job_runs`);
});

/** Inserts a run that finished `daysAgo` days ago. */
async function seedRun(daysAgo: number, jobName = "scheduler.tick") {
  await db.execute(sql`
    insert into job_runs (job_name, started_at, finished_at, status)
    values (${jobName},
            now() - ((${String(daysAgo)})::text || ' days')::interval,
            now() - ((${String(daysAgo)})::text || ' days')::interval,
            'success')
  `);
}

async function countRuns() {
  const rows = await db.execute<{ c: number }>(sql`select count(*)::int c from job_runs`);
  const list = Array.isArray(rows) ? rows : ((rows as never as { rows: unknown[] }).rows ?? []);
  return Number((list[0] as { c: number }).c);
}

describe("pruneOldJobRuns", () => {
  it("deletes runs older than the retention window", async () => {
    await seedRun(45);
    await seedRun(31);

    const result = await pruneOldJobRuns();

    expect(result.deleted).toBe(2);
    expect(await countRuns()).toBe(0);
  });

  // The property that protects recent history: an over-eager delete here
  // would erase the very rows an operator needs during an incident.
  it("keeps everything inside the window, including the boundary", async () => {
    await seedRun(29);
    await seedRun(1);
    await seedRun(0);

    const result = await pruneOldJobRuns();

    expect(result.deleted).toBe(0);
    expect(await countRuns()).toBe(3);
  });

  it("deletes only the old rows when both are present", async () => {
    await seedRun(60);
    await seedRun(31);
    await seedRun(10);
    await seedRun(0);

    const result = await pruneOldJobRuns();

    expect(result.deleted).toBe(2);
    expect(await countRuns()).toBe(2);
  });

  it("is a no-op on an empty table", async () => {
    const result = await pruneOldJobRuns();
    expect(result).toMatchObject({ deleted: 0, truncated: false });
  });

  it("is idempotent — a second run has nothing left to do", async () => {
    await seedRun(40);
    await pruneOldJobRuns();

    const second = await pruneOldJobRuns();

    expect(second.deleted).toBe(0);
    expect(await countRuns()).toBe(0);
  });

  it("honours a custom retention window", async () => {
    await seedRun(10);
    await seedRun(2);

    const result = await pruneOldJobRuns(7);

    expect(result.deleted).toBe(1);
    expect(await countRuns()).toBe(1);
  });

  it("reports how many batches it took", async () => {
    await seedRun(40);
    const result = await pruneOldJobRuns();
    expect(result.batches).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("touches no other table", async () => {
    const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
    await db.insert(schema.auditLogs).values({
      organizationId: org.id,
      eventType: "test.event",
      actorType: "system",
      description: "must survive",
      occurredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });
    await seedRun(40);

    await pruneOldJobRuns();

    // audit_logs is the immutable audit trail and must never be pruned by
    // this, however old the row is.
    const audit = await db.select().from(schema.auditLogs);
    expect(audit).toHaveLength(1);
  });

  it("ships a 30-day default", () => {
    expect(JOB_RUN_RETENTION_DAYS).toBe(30);
  });
});
