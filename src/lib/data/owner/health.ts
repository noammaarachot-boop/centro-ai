import { and, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, jobRuns } from "@/db/schema";

// Windowed (last 24h), not full-history — this table is the app's only
// immutable event log and its existing consumer (the org's own /audit
// page) shows everything unfiltered, so a health check has to bound its
// own scan rather than aggregating forever.
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OwnerHealthSignals {
  failedJobRunsLast24h: number;
  warningAuditEventsLast24h: number;
  criticalAuditEventsLast24h: number;
}

export async function getOwnerHealthSignals(): Promise<OwnerHealthSignals> {
  const db = await getDb();
  const windowStart = new Date(Date.now() - HEALTH_WINDOW_MS);

  const [{ count: failedJobRunsLast24h }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobRuns)
    .where(and(gte(jobRuns.finishedAt, windowStart), sql`${jobRuns.status} = 'failed'`));

  const [{ count: warningAuditEventsLast24h }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(gte(auditLogs.occurredAt, windowStart), sql`${auditLogs.metadata}->>'severity' = 'warning'`)
    );

  const [{ count: criticalAuditEventsLast24h }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(gte(auditLogs.occurredAt, windowStart), sql`${auditLogs.metadata}->>'severity' = 'critical'`)
    );

  return { failedJobRunsLast24h, warningAuditEventsLast24h, criticalAuditEventsLast24h };
}
