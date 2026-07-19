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
