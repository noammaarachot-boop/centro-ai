import { getDb } from "@/db";
import { platformOwnerAuditLog } from "@/db/schema";

type OwnerAuditSeverity = "info" | "warning" | "critical";

interface RecordOwnerAuditEventInput {
  eventType: string;
  description: string;
  severity?: OwnerAuditSeverity;
  platformOwnerId?: string;
  metadata?: Record<string, unknown>;
}

// Mirrors src/lib/audit.ts's recordAuditEvent — the only write path onto
// platform_owner_audit_log, insert-only by design (same rationale as
// auditLogs: an immutable trail of the owner's own actions on the
// platform). `severity` defaults to "info"; pass "warning"/"critical" for
// events a future alerting mechanism should be able to pick out without
// re-deriving them.
export async function recordOwnerAuditEvent(input: RecordOwnerAuditEventInput) {
  const db = await getDb();
  await db.insert(platformOwnerAuditLog).values({
    eventType: input.eventType,
    description: input.description,
    severity: input.severity ?? "info",
    platformOwnerId: input.platformOwnerId,
    metadata: input.metadata,
  });
}
