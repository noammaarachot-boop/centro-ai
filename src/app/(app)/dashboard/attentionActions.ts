"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { attentionDismissals, collectionRequests } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { getItemsNeedingReview, type ReviewReasonKind } from "@/lib/data/dashboardReadModel";
import { clearEscalation } from "@/lib/collectionRequestStateMachine";

/**
 * "טופל" — the employee has dealt with one attention item.
 *
 * Records a dismissal ALONGSIDE the underlying condition and changes nothing
 * about it: no request is closed, no document accepted, no question resolved,
 * no status touched. Those are business decisions with their own actions;
 * this only says a human has seen it and acted.
 *
 * The occurrence being dismissed is read from the live attention list rather
 * than taken from the form, so a stale page cannot silence a NEWER occurrence
 * of the same problem than the one the employee was actually looking at.
 */
export interface DismissAttentionState {
  error?: string;
}

export async function dismissAttentionItem(
  collectionRequestId: string,
  reasonKind: ReviewReasonKind,
  sourceId: string,
  _prevState: DismissAttentionState,
  _formData: FormData
): Promise<DismissAttentionState> {
  const session = await requireSession();
  const db = await getDb();

  // Tenant isolation: the request must belong to THIS employee's
  // organization. A request from another organization is simply not found —
  // never read, never dismissed.
  const [request] = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, session.organizationId)
      )
    )
    .limit(1);
  if (!request) {
    return { error: "הבקשה לא נמצאה." };
  }

  // Re-derive from the live list: this is the only trustworthy source of
  // which occurrence is currently open, and it is already scoped to the
  // organization.
  const items = await getItemsNeedingReview(session.organizationId);
  const item = items.find((candidate) => candidate.collectionRequestId === collectionRequestId);
  const reason = item?.reasons.find(
    (candidate) => candidate.kind === reasonKind && (candidate.sourceId ?? "") === sourceId
  );
  if (!reason) {
    // Already handled, or resolved itself in the meantime. Refreshing is the
    // honest outcome — the row is simply gone.
    refresh();
    return {};
  }

  await db
    .insert(attentionDismissals)
    .values({
      organizationId: session.organizationId,
      collectionRequestId,
      reasonKind,
      sourceId,
      occurrenceAt: reason.occurredAt,
      reasonDetail: reason.detail,
      dismissedByUserId: session.userId,
    })
    // The unique index makes a double click or a retry a no-op rather than a
    // second row.
    .onConflictDoNothing();

  // An escalation is a flag on the request, so handling it clears that flag.
  // The lifecycle is untouched and always was: the request has been
  // waiting_for_client (or active) throughout, and nothing has to be guessed
  // back. Nothing is completed, cancelled or accepted here.
  if (reasonKind === "escalated") {
    await clearEscalation(session.organizationId, collectionRequestId);
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "attention.dismissed",
    description: `סומן כטופל: ${describeReason(reasonKind)}${reason.detail ? ` — ${reason.detail}` : ""}`,
    actorType: "employee",
    actorUserId: session.userId,
    collectionRequestId,
    metadata: {
      reasonKind,
      sourceId,
      occurrenceAt: reason.occurredAt.toISOString(),
    },
  });

  refresh();
  return {};
}

function describeReason(kind: ReviewReasonKind): string {
  switch (kind) {
    case "escalated":
      return "בקשה שהוסלמה";
    case "document_needs_review":
      return "מסמך שממתין לבדיקה";
    case "employee_question":
      return "שאלה של לקוח";
    case "reported_missing":
      return "מסמך שהלקוח דיווח כחסר";
    case "client_overdue":
      return "לקוח שלא הגיב";
    case "message_failed":
      return "הודעה שלא נמסרה";
  }
}
