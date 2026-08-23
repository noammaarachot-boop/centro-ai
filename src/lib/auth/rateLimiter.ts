import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * Shared, Postgres-backed rate limiting.
 *
 * This was previously a process-local `Map`, justified by "a pilot runs as a
 * single server instance". On Vercel that is not true: the app runs as
 * serverless functions, so requests are spread across many concurrent
 * instances and every cold start begins with an empty Map. Five failed login
 * attempts would land on five different instances, each counting "1", and no
 * threshold was ever reached — the protection was not weak, it was absent.
 *
 * Postgres is the store because every request being protected already needs
 * it, so this adds no infrastructure and no new failure mode. Errors are
 * deliberately allowed to propagate: a caller that cannot reach the database
 * cannot authenticate anyone either, so silently treating that as "not rate
 * limited" would only ever weaken the guarantee.
 */

export interface RateLimitPolicy {
  windowMs: number;
  /** Attempts allowed within the window before the caller is limited. */
  max: number;
}

/** Failed logins and password-reset requests: 5 per 15 minutes, per address. */
export const AUTH_POLICY: RateLimitPolicy = { windowMs: 15 * 60 * 1000, max: 5 };
/** Support form and public contact form: 5 per 10 minutes. */
export const SUBMISSION_POLICY: RateLimitPolicy = { windowMs: 10 * 60 * 1000, max: 5 };
/** Assistant chat turns: 20 per 5 minutes, per user. */
export const ASSISTANT_POLICY: RateLimitPolicy = { windowMs: 5 * 60 * 1000, max: 20 };

const interval = (ms: number) => sql`((${String(ms)})::text || ' milliseconds')::interval`;

/**
 * Increments the counter for `key` and reports whether it has now exceeded
 * the policy.
 *
 * One statement, so the read-modify-write cannot interleave with a
 * concurrent request — which is the entire point of moving off the Map. The
 * window resets only when it has actually elapsed; it is never extended by
 * further attempts, so a caller cannot be locked out indefinitely by
 * continuing to retry.
 */
export async function consumeRateLimit(key: string, policy: RateLimitPolicy): Promise<boolean> {
  const db = await getDb();
  const window = interval(policy.windowMs);
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limit_attempts (key, count, first_attempt_at, expires_at)
    values (${key}, 1, now(), now() + ${window})
    on conflict (key) do update set
      count = case
        when rate_limit_attempts.first_attempt_at <= now() - ${window} then 1
        else rate_limit_attempts.count + 1 end,
      first_attempt_at = case
        when rate_limit_attempts.first_attempt_at <= now() - ${window} then now()
        else rate_limit_attempts.first_attempt_at end,
      expires_at = now() + ${window}
    returning count
  `);
  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []);
  const count = Number((list[0] as { count?: number } | undefined)?.count ?? 1);
  return count > policy.max;
}

/**
 * Read-only check — does NOT count as an attempt.
 *
 * Login uses this because only *failed* attempts should count: a correct
 * password must not consume the budget, and it clears it instead.
 */
export async function isRateLimited(key: string, policy: RateLimitPolicy): Promise<boolean> {
  const db = await getDb();
  const rows = await db.execute<{ count: number }>(sql`
    select count from rate_limit_attempts
    where key = ${key} and first_attempt_at > now() - ${interval(policy.windowMs)}
  `);
  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []);
  if (list.length === 0) return false;
  return Number((list[0] as { count?: number }).count ?? 0) >= policy.max;
}

export async function recordFailedAttempt(key: string, policy: RateLimitPolicy): Promise<void> {
  await consumeRateLimit(key, policy);
}

/** Called on a successful login, so a user is never punished for earlier typos. */
export async function clearAttempts(key: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`delete from rate_limit_attempts where key = ${key}`);
}

/**
 * Removes rows whose window has fully elapsed.
 *
 * Only keys never seen again accumulate — an active key resets itself in
 * place via the upsert above — so this is housekeeping, not a hot path.
 */
export async function cleanupExpiredRateLimits(): Promise<number> {
  const db = await getDb();
  const rows = await db.execute(sql`
    delete from rate_limit_attempts where expires_at < now() returning key
  `);
  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows: unknown[] }).rows ?? []);
  return list.length;
}
