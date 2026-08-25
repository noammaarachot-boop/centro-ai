import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * Retention for job_runs — cron telemetry, one row per tick.
 *
 * It is already the largest table in the system (3,549 rows / 1.7 MB) purely
 * from the scheduler, growing ~105,000 rows a year regardless of how many
 * tenants exist, and nothing ever removed a row.
 *
 * Safe to delete from, and that matters:
 *   • no foreign key points at job_runs, so deletion is dependency-free;
 *   • it holds no organizationId and no customer data — it is telemetry
 *     about whether the cron ran, not business data;
 *   • it is NOT the audit trail. audit_logs is, it is immutable by design
 *     (FR-17.4), and it must never get the same treatment.
 *
 * 30 days is generous on purpose. The only consumer reads a 24-hour window
 * (src/lib/data/owner/health.ts), so everything beyond a day is headroom for
 * a human investigating an incident, not something the product depends on.
 */

export const JOB_RUN_RETENTION_DAYS = 30;
/** Rows per statement. Small enough that no single delete holds a long lock. */
export const JOB_RUN_DELETE_BATCH = 5_000;
/** Stops a pathological run from looping forever; 50 × 5,000 = 250,000 rows. */
const MAX_BATCHES = 50;

export interface JobRunPruneResult {
  deleted: number;
  batches: number;
  /** True when the cap was hit and older rows remain for the next tick. */
  truncated: boolean;
}

/**
 * Deletes finished job runs older than the retention window, in batches.
 *
 * Batched rather than one big DELETE so the table is never locked for long.
 * Postgres has no `DELETE ... LIMIT`, hence the `IN (SELECT ... LIMIT)`
 * form. Keyed on finished_at — the column the only consumer filters on, and
 * NOT NULL, so no row can slip through the comparison.
 */
export async function pruneOldJobRuns(
  retentionDays: number = JOB_RUN_RETENTION_DAYS
): Promise<JobRunPruneResult> {
  const db = await getDb();
  let deleted = 0;
  let batches = 0;

  for (; batches < MAX_BATCHES; batches += 1) {
    const rows = await db.execute(sql`
      delete from job_runs
      where id in (
        select id from job_runs
        where finished_at < now() - ((${String(retentionDays)})::text || ' days')::interval
        limit ${JOB_RUN_DELETE_BATCH}
      )
      returning id
    `);
    const list = Array.isArray(rows)
      ? rows
      : ((rows as unknown as { rows: unknown[] }).rows ?? []);

    deleted += list.length;
    if (list.length < JOB_RUN_DELETE_BATCH) {
      return { deleted, batches: batches + 1, truncated: false };
    }
  }

  return { deleted, batches, truncated: true };
}
