import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, clients, users } from "@/db/schema";

export interface AuditLogFilters {
  clientId?: string;
  collectionRequestId?: string;
}

// FR-17.3: chronological history — org-wide (Ch.17 general audit view)
// or scoped to one Collection Request when collectionRequestId is given.
export async function listAuditLog(
  organizationId: string,
  filters: AuditLogFilters = {},
  limit = 200
) {
  const db = await getDb();
  const conditions = [eq(auditLogs.organizationId, organizationId)];
  if (filters.clientId) conditions.push(eq(auditLogs.clientId, filters.clientId));
  if (filters.collectionRequestId) {
    conditions.push(eq(auditLogs.collectionRequestId, filters.collectionRequestId));
  }

  return db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      eventType: auditLogs.eventType,
      actorType: auditLogs.actorType,
      description: auditLogs.description,
      metadata: auditLogs.metadata,
      clientName: clients.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(clients, eq(auditLogs.clientId, clients.id))
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(limit);
}

// Used by the onboarding wizard's Step 5 (src/app/onboarding/page.tsx) to
// re-display the most recent import's column-analysis summary — which
// columns Centro detected as name/phone/email/business-type, and at what
// confidence — after the redirect from Step 4 has already discarded that
// action's in-memory return value.
export async function getLatestAuditEventByType(organizationId: string, eventType: string) {
  const db = await getDb();
  const [row] = await db
    .select({ metadata: auditLogs.metadata, occurredAt: auditLogs.occurredAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.eventType, eventType)))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(1);
  return row ?? null;
}
