import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
  serviceDocumentRequirements,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";

export type CollectionRequestStatus =
  | "draft"
  | "active"
  | "waiting_for_client"
  | "processing"
  | "completed"
  | "escalated"
  | "cancelled";

// EPS Ch.6: Draft → Active → Waiting for Client → Processing → Completed /
// Escalated / Cancelled. `completed` only transitions back to `active` via
// the reopen action (Ch.16 FR-16.8 / glossary "Reopened Collection"), never
// forward again — everything else follows the diagram directly. FR-6.2:
// every transition must be validated before execution.
const ALLOWED_TRANSITIONS: Record<
  CollectionRequestStatus,
  CollectionRequestStatus[]
> = {
  draft: ["active", "cancelled"],
  active: ["waiting_for_client", "processing", "escalated", "cancelled"],
  waiting_for_client: ["active", "processing", "escalated", "cancelled"],
  processing: ["waiting_for_client", "completed", "escalated", "cancelled"],
  escalated: ["active", "waiting_for_client", "processing", "cancelled"],
  completed: ["active"],
  cancelled: [],
};

export function canTransition(
  from: CollectionRequestStatus,
  to: CollectionRequestStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatusOptions(
  from: CollectionRequestStatus
): CollectionRequestStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

// BR-11.2: the request remains open until all required documents are
// received. BR-6.1: only validated (approved) documents satisfy a
// requirement. BR-6.2: documents still "processing" block completion.
export async function checkCompletionGate(
  collectionRequestId: string
): Promise<string | null> {
  const db = await getDb();

  const requirements = await db
    .select({ id: collectionRequestRequirements.id })
    .from(collectionRequestRequirements)
    .where(
      eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
    );

  const requestDocuments = await db
    .select({
      requirementId: documents.requirementId,
      status: documents.status,
    })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  if (requestDocuments.some((doc) => doc.status === "processing")) {
    return "לא ניתן להשלים בקשה כאשר יש מסמכים בעיבוד.";
  }

  const approvedRequirementIds = new Set(
    requestDocuments
      .filter((doc) => doc.status === "approved" && doc.requirementId)
      .map((doc) => doc.requirementId)
  );

  const unsatisfied = requirements.filter(
    (req) => !approvedRequirementIds.has(req.id)
  );
  if (unsatisfied.length > 0) {
    return `יש ${unsatisfied.length} דרישות מסמכים שטרם אושרו.`;
  }

  return null;
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
}

// Non-redirecting core of a status change: validates the transition
// (FR-6.2), runs the completion gate when moving to `completed`, applies
// the update, and records the audit event (FR-6.3). Server actions that
// need a single transition wrap this and redirect on the result; the
// conversation orchestration (M8) composes multiple calls in sequence
// (e.g. waiting_for_client -> processing -> completed) without any
// redirect happening mid-sequence.
export async function applyTransition(
  organizationId: string,
  actorUserId: string | undefined,
  actorType: "employee" | "ai" | "system" | "client",
  collectionRequestId: string,
  nextStatus: CollectionRequestStatus
): Promise<TransitionResult> {
  const db = await getDb();
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!current) return { ok: false, error: "בקשת האיסוף לא נמצאה." };

  if (!canTransition(current.status, nextStatus)) {
    return { ok: false, error: "מעבר סטטוס לא חוקי." };
  }

  if (nextStatus === "completed") {
    const gateError = await checkCompletionGate(collectionRequestId);
    if (gateError) return { ok: false, error: gateError };
  }

  await db
    .update(collectionRequests)
    .set({
      status: nextStatus,
      updatedAt: new Date(),
      completedAt: nextStatus === "completed" ? new Date() : current.completedAt,
    })
    .where(eq(collectionRequests.id, collectionRequestId));

  await recordAuditEvent({
    organizationId,
    eventType: "collection_request.status_changed",
    description: `סטטוס בקשת האיסוף עודכן מ-${current.status} ל-${nextStatus}`,
    actorType,
    actorUserId,
    clientId: current.clientId,
    collectionRequestId,
    metadata: { from: current.status, to: nextStatus },
  });

  if (nextStatus === "completed") {
    await exitLearningModeIfFirstCycle(organizationId, current.clientId);
  }

  return { ok: true };
}

// Milestone 2 (Architecture Ch.1/Ch.2) — every client begins in Learning
// Mode; it ends, once, the first time any of their Collection Requests
// reaches `completed`. Idempotent by construction: the WHERE clause only
// ever matches a client still in Learning Mode, so a client's second and
// every later completed cycle is a silent no-op here.
async function exitLearningModeIfFirstCycle(organizationId: string, clientId: string) {
  const db = await getDb();
  await db
    .update(clients)
    .set({ learningMode: false, firstCycleCompletedAt: new Date() })
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.organizationId, organizationId),
        eq(clients.learningMode, true)
      )
    );
}

// Steps through whichever valid intermediate transitions are needed to
// reach `completed` from the current status (e.g. waiting_for_client ->
// processing -> completed), stopping at the first failure.
export async function completeCollectionRequest(
  organizationId: string,
  actorUserId: string | undefined,
  actorType: "employee" | "ai" | "system" | "client",
  collectionRequestId: string
): Promise<TransitionResult> {
  const db = await getDb();
  const [current] = await db
    .select({ status: collectionRequests.status })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!current) return { ok: false, error: "בקשת האיסוף לא נמצאה." };

  if (current.status !== "processing" && current.status !== "completed") {
    const toProcessing = await applyTransition(
      organizationId,
      actorUserId,
      actorType,
      collectionRequestId,
      "processing"
    );
    if (!toProcessing.ok) return toProcessing;
  }

  if (current.status === "completed") return { ok: true };

  return applyTransition(
    organizationId,
    actorUserId,
    actorType,
    collectionRequestId,
    "completed"
  );
}

export async function snapshotServiceRequirements(
  collectionRequestId: string,
  serviceId: string
) {
  const db = await getDb();
  const templates = await db
    .select()
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, serviceId));

  if (templates.length === 0) return;

  await db.insert(collectionRequestRequirements).values(
    templates.map((template) => ({
      collectionRequestId,
      sourceRequirementId: template.id,
      name: template.name,
      description: template.description,
    }))
  );
}
