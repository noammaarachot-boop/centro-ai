import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";

type AuditActorType = "employee" | "ai" | "client" | "system";

interface RecordAuditEventInput {
  organizationId: string;
  eventType: string;
  description: string;
  actorType: AuditActorType;
  actorUserId?: string;
  clientId?: string;
  collectionRequestId?: string;
  metadata?: Record<string, unknown>;
}

// The only write path onto audit_logs (FR-17.1/BR-17.1: logging is
// automatic and covers every significant event; FR-17.4: records are
// immutable, so there is deliberately no update/delete counterpart here).
export async function recordAuditEvent(input: RecordAuditEventInput) {
  const db = await getDb();
  await db.insert(auditLogs).values({
    organizationId: input.organizationId,
    eventType: input.eventType,
    description: input.description,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    clientId: input.clientId,
    collectionRequestId: input.collectionRequestId,
    metadata: input.metadata,
  });
}
