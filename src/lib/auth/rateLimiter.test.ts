import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// The property that was missing in production: a counter that survives
// across requests and is shared by every instance. The old Map-based
// limiter passed its own tests while providing no protection at all on
// Vercel, because each serverless instance counted separately — so these
// deliberately exercise the counter through the database, not through a
// process-local structure.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const {
  consumeRateLimit,
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
  cleanupExpiredRateLimits,
  AUTH_POLICY,
  SUBMISSION_POLICY,
  ASSISTANT_POLICY,
} = await import("./rateLimiter");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
  await db.execute(sql`select 1`);
}, 60_000);

beforeEach(async () => {
  await db.execute(sql`delete from rate_limit_attempts`);
});

const key = () => `test:${crypto.randomUUID()}`;

describe("consumeRateLimit", () => {
  it("allows exactly `max` attempts, then limits", async () => {
    const k = key();
    const policy = { windowMs: 60_000, max: 3 };

    expect(await consumeRateLimit(k, policy)).toBe(false); // 1
    expect(await consumeRateLimit(k, policy)).toBe(false); // 2
    expect(await consumeRateLimit(k, policy)).toBe(false); // 3
    expect(await consumeRateLimit(k, policy)).toBe(true); // 4 — over
    expect(await consumeRateLimit(k, policy)).toBe(true);
  });

  it("counts persist across calls — the whole point of the rewrite", async () => {
    const k = key();
    await consumeRateLimit(k, AUTH_POLICY);
    await consumeRateLimit(k, AUTH_POLICY);

    const rows = await db.execute<{ count: number }>(
      sql`select count from rate_limit_attempts where key = ${k}`
    );
    const list = Array.isArray(rows) ? rows : (rows as never as { rows: unknown[] }).rows;
    expect(Number((list[0] as { count: number }).count)).toBe(2);
  });

  it("keeps different keys completely independent", async () => {
    const a = key();
    const b = key();
    const policy = { windowMs: 60_000, max: 2 };

    await consumeRateLimit(a, policy);
    await consumeRateLimit(a, policy);
    expect(await consumeRateLimit(a, policy)).toBe(true);
    // b has its own budget, untouched by a exhausting theirs.
    expect(await consumeRateLimit(b, policy)).toBe(false);
  });

  it("resets once the window has elapsed", async () => {
    const k = key();
    const policy = { windowMs: 60_000, max: 2 };
    await consumeRateLimit(k, policy);
    await consumeRateLimit(k, policy);
    expect(await consumeRateLimit(k, policy)).toBe(true);

    // Age the window out rather than waiting a real minute.
    await db.execute(sql`
      update rate_limit_attempts set first_attempt_at = now() - interval '2 minutes'
      where key = ${k}`);

    expect(await consumeRateLimit(k, policy)).toBe(false);
  });

  // A caller that keeps hammering must not extend their own lockout
  // forever — the window slides only when it expires.
  it("does not extend the window on every attempt", async () => {
    const k = key();
    const policy = { windowMs: 60_000, max: 1 };
    await consumeRateLimit(k, policy);

    const before = await db.execute<{ first_attempt_at: string }>(
      sql`select first_attempt_at from rate_limit_attempts where key = ${k}`
    );
    const firstAt = (Array.isArray(before) ? before : (before as never as { rows: unknown[] }).rows)[0];

    await consumeRateLimit(k, policy);
    await consumeRateLimit(k, policy);

    const after = await db.execute<{ first_attempt_at: string }>(
      sql`select first_attempt_at from rate_limit_attempts where key = ${k}`
    );
    const laterAt = (Array.isArray(after) ? after : (after as never as { rows: unknown[] }).rows)[0];
    expect(String((laterAt as { first_attempt_at: unknown }).first_attempt_at))
      .toBe(String((firstAt as { first_attempt_at: unknown }).first_attempt_at));
  });

  it("is atomic under concurrent attempts on the same key", async () => {
    const k = key();
    const policy = { windowMs: 60_000, max: 5 };

    // 20 simultaneous attempts. If the increment were read-modify-write in
    // application code, counts would be lost and fewer than 15 would be
    // rejected. A single upsert cannot lose any.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(k, policy))
    );

    expect(results.filter((limited) => !limited)).toHaveLength(5);
    expect(results.filter((limited) => limited)).toHaveLength(15);
  });
});

describe("isRateLimited / recordFailedAttempt — the login pattern", () => {
  it("checking does not consume the budget", async () => {
    const k = key();
    for (let i = 0; i < 10; i += 1) {
      expect(await isRateLimited(k, AUTH_POLICY)).toBe(false);
    }
  });

  it("limits only after `max` recorded failures", async () => {
    const k = key();
    for (let i = 0; i < AUTH_POLICY.max; i += 1) {
      expect(await isRateLimited(k, AUTH_POLICY)).toBe(false);
      await recordFailedAttempt(k, AUTH_POLICY);
    }
    expect(await isRateLimited(k, AUTH_POLICY)).toBe(true);
  });

  it("a successful login clears the record, so earlier typos never linger", async () => {
    const k = key();
    for (let i = 0; i < AUTH_POLICY.max; i += 1) await recordFailedAttempt(k, AUTH_POLICY);
    expect(await isRateLimited(k, AUTH_POLICY)).toBe(true);

    await clearAttempts(k);

    expect(await isRateLimited(k, AUTH_POLICY)).toBe(false);
  });

  it("ignores a record whose window has already elapsed", async () => {
    const k = key();
    for (let i = 0; i < AUTH_POLICY.max; i += 1) await recordFailedAttempt(k, AUTH_POLICY);
    await db.execute(sql`
      update rate_limit_attempts set first_attempt_at = now() - interval '20 minutes'
      where key = ${k}`);

    expect(await isRateLimited(k, AUTH_POLICY)).toBe(false);
  });
});

describe("cleanupExpiredRateLimits", () => {
  it("removes only rows whose window has fully elapsed", async () => {
    const stale = key();
    const fresh = key();
    await consumeRateLimit(stale, AUTH_POLICY);
    await consumeRateLimit(fresh, AUTH_POLICY);
    await db.execute(sql`
      update rate_limit_attempts set expires_at = now() - interval '1 minute' where key = ${stale}`);

    const removed = await cleanupExpiredRateLimits();

    expect(removed).toBe(1);
    const left = await db.execute<{ key: string }>(sql`select key from rate_limit_attempts`);
    const list = Array.isArray(left) ? left : (left as never as { rows: unknown[] }).rows;
    expect(list).toHaveLength(1);
    expect((list[0] as { key: string }).key).toBe(fresh);
  });
});

describe("the shipped policies match what each surface had before", () => {
  it("preserves every previous limit exactly", () => {
    expect(AUTH_POLICY).toEqual({ windowMs: 15 * 60 * 1000, max: 5 });
    expect(SUBMISSION_POLICY).toEqual({ windowMs: 10 * 60 * 1000, max: 5 });
    expect(ASSISTANT_POLICY).toEqual({ windowMs: 5 * 60 * 1000, max: 20 });
  });
});
