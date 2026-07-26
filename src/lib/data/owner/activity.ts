import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, platformOwnerAuditLog } from "@/db/schema";

// Cross-organization activity feed for the Owner Dashboard's home page —
// merges the per-organization audit_logs table (generalized here to no
// organizationId filter, unlike listAuditLog()) with the owner's own
// platform_owner_audit_log. job_runs (system-tick outcomes) joins this
// feed in a later phase; the shape below is designed so that's additive.

export type OwnerActivityEvent = {
  id: string;
  occurredAt: Date;
  eventType: string;
  description: string;
  source: "organization" | "owner";
  organizationName: string | null;
};

const FEED_LIMIT = 40;

export async function listRecentActivity(): Promise<OwnerActivityEvent[]> {
  const db = await getDb();

  const orgEvents = await db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      eventType: auditLogs.eventType,
      description: auditLogs.description,
      organizationName: organizations.name,
    })
    .from(auditLogs)
    .innerJoin(organizations, sql`${organizations.id} = ${auditLogs.organizationId}`)
    .orderBy(desc(auditLogs.occurredAt))
    .limit(FEED_LIMIT);

  const ownerEvents = await db
    .select({
      id: platformOwnerAuditLog.id,
      occurredAt: platformOwnerAuditLog.occurredAt,
      eventType: platformOwnerAuditLog.eventType,
      description: platformOwnerAuditLog.description,
    })
    .from(platformOwnerAuditLog)
    .orderBy(desc(platformOwnerAuditLog.occurredAt))
    .limit(FEED_LIMIT);

  const merged: OwnerActivityEvent[] = [
    ...orgEvents.map((e) => ({ ...e, source: "organization" as const })),
    ...ownerEvents.map((e) => ({ ...e, source: "owner" as const, organizationName: null })),
  ];

  merged.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return merged.slice(0, FEED_LIMIT);
}
