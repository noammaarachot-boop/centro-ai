import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { attentionDismissals, auditLogs, collectionRequests, conversations } from "@/db/schema";

/**
 * Moves rows written by the old model onto the new one.
 *
 * Before escalation became its own field, escalating a request OVERWROTE
 * collectionRequests.status with "escalated", destroying the lifecycle value
 * underneath it. Nothing writes that any more, but rows carrying it are still
 * in production and would read as permanently "דורש טיפול" with no way to
 * clear them — one of them is exactly that: an employee pressed "טופל", the
 * dismissal was recorded, and because the deploy that could restore the
 * status landed thirteen minutes later the request kept its escalated status
 * while dropping out of the attention list that owns the "טופל" button.
 *
 * For each affected request this reconstructs both facts:
 *
 *  • the LIFECYCLE, from the conversation, using the same pairing
 *    isWaitingForClientCondition encodes — a conversation waiting on its
 *    client means the request is waiting_for_client, an open one means
 *    active. Never a guess beyond what that already-shared rule says.
 *
 *  • the ESCALATION, from its own audit event (collection_request.escalated),
 *    falling back to updatedAt only when no event survives. Unless an
 *    employee already dismissed it, in which case it is cleared outright —
 *    that is what pressing "טופל" was supposed to do.
 *
 * Idempotent: it selects only rows still carrying status='escalated', and
 * leaves none behind, so a second run finds nothing. Nothing is deleted —
 * dismissals and audit history are read, never written over — and every
 * change is recorded as its own audit event. Terminal requests are excluded:
 * a completed or cancelled request has a real answer already.
 */
export interface EscalationReconciliationRow {
  organizationId: string;
  collectionRequestId: string;
  fromStatus: string;
  toStatus: "active" | "waiting_for_client";
  escalatedAt: Date | null;
  alreadyDismissed: boolean;
}

export interface EscalationReconciliationPlan {
  rows: EscalationReconciliationRow[];
  organizationsAffected: number;
}

export async function planEscalationReconciliation(): Promise<EscalationReconciliationPlan> {
  const db = await getDb();

  const stranded = await db
    .select({
      id: collectionRequests.id,
      organizationId: collectionRequests.organizationId,
      status: collectionRequests.status,
      updatedAt: collectionRequests.updatedAt,
      escalatedAt: collectionRequests.escalatedAt,
      conversationStatus: conversations.status,
    })
    .from(collectionRequests)
    .leftJoin(conversations, eq(conversations.collectionRequestId, collectionRequests.id))
    .where(eq(collectionRequests.status, "escalated"));

  if (stranded.length === 0) return { rows: [], organizationsAffected: 0 };

  const ids = stranded.map((row) => row.id);

  // When the escalation actually happened, from its own event rather than
  // from updatedAt — any later unrelated write moved updatedAt, which is
  // precisely why it was the wrong thing to key a dismissal on.
  const escalationEvents = await db
    .select({
      collectionRequestId: auditLogs.collectionRequestId,
      occurredAt: auditLogs.occurredAt,
    })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.collectionRequestId, ids),
        eq(auditLogs.eventType, "collection_request.escalated")
      )
    );
  const escalatedAtByRequest = new Map<string, Date>();
  for (const event of escalationEvents) {
    if (!event.collectionRequestId) continue;
    const seen = escalatedAtByRequest.get(event.collectionRequestId);
    // The most recent escalation is the one the row is currently carrying.
    if (!seen || event.occurredAt.getTime() > seen.getTime()) {
      escalatedAtByRequest.set(event.collectionRequestId, event.occurredAt);
    }
  }

  const dismissals = await db
    .select({ collectionRequestId: attentionDismissals.collectionRequestId })
    .from(attentionDismissals)
    .where(
      and(
        inArray(attentionDismissals.collectionRequestId, ids),
        eq(attentionDismissals.reasonKind, "escalated")
      )
    );
  const dismissed = new Set(dismissals.map((row) => row.collectionRequestId));

  const rows: EscalationReconciliationRow[] = stranded.map((row) => {
    const alreadyDismissed = dismissed.has(row.id);
    return {
      organizationId: row.organizationId,
      collectionRequestId: row.id,
      fromStatus: row.status,
      toStatus: row.conversationStatus === "waiting_for_client" ? "waiting_for_client" : "active",
      // An escalation an employee already handled is cleared, not carried
      // over — otherwise reconciliation would resurrect an alert they closed.
      escalatedAt: alreadyDismissed ? null : (escalatedAtByRequest.get(row.id) ?? row.updatedAt),
      alreadyDismissed,
    };
  });

  return {
    rows,
    organizationsAffected: new Set(rows.map((row) => row.organizationId)).size,
  };
}

export async function applyEscalationReconciliation(
  plan: EscalationReconciliationPlan
): Promise<number> {
  const db = await getDb();
  let applied = 0;

  for (const row of plan.rows) {
    // Scoped by organizationId as well as id on every write, and guarded by
    // the old status so a request someone moved in the meantime is left
    // alone rather than overwritten by a stale plan.
    const [updated] = await db
      .update(collectionRequests)
      .set({
        status: row.toStatus,
        escalatedAt: row.escalatedAt,
        ...(row.alreadyDismissed ? { escalationReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(collectionRequests.id, row.collectionRequestId),
          eq(collectionRequests.organizationId, row.organizationId),
          eq(collectionRequests.status, "escalated")
        )
      )
      .returning({ id: collectionRequests.id });
    if (!updated) continue;

    await db.insert(auditLogs).values({
      organizationId: row.organizationId,
      collectionRequestId: row.collectionRequestId,
      eventType: "collection_request.escalation_reconciled",
      actorType: "system",
      description: row.alreadyDismissed
        ? `הסטטוס שוחזר ל-${row.toStatus} וההסלמה נוקתה — היא כבר סומנה כטופלה`
        : `הסטטוס שוחזר ל-${row.toStatus}; ההסלמה נשמרה כשדה נפרד`,
      metadata: {
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        escalatedAt: row.escalatedAt?.toISOString() ?? null,
        alreadyDismissed: row.alreadyDismissed,
      },
    });
    applied += 1;
  }

  return applied;
}

/**
 * Requests whose escalation flag survived their own completion.
 *
 * Nothing in the new model can produce this — escalateToHumanReview refuses
 * terminal requests — but a row reconciled from the old model could carry one,
 * and a finished request must never sit in anyone's attention list.
 */
export async function clearEscalationsOnTerminalRequests(): Promise<number> {
  const db = await getDb();
  const cleared = await db
    .update(collectionRequests)
    .set({ escalatedAt: null, escalationReason: null })
    .where(
      and(
        inArray(collectionRequests.status, ["completed", "cancelled"]),
        isNotNull(collectionRequests.escalatedAt)
      )
    )
    .returning({ id: collectionRequests.id });
  return cleared.length;
}
