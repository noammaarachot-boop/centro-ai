import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { detectMissingRequirements, resolveEffectiveRequirementNames } from "@/lib/clientDocumentProfile";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";
import { resolveExplicitPeriodsForSnapshot, type RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

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
    .select({
      id: collectionRequestRequirements.id,
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
    })
    .from(collectionRequestRequirements)
    .where(
      eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
    );

  const requestDocuments = await db
    .select({
      requirementId: documents.requirementId,
      status: documents.status,
      extractedPeriodLabel: documents.extractedPeriodLabel,
      extractedPersonName: documents.extractedPersonName,
      continuationOfDocumentId: documents.continuationOfDocumentId,
    })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  if (requestDocuments.some((doc) => doc.status === "processing")) {
    return "לא ניתן להשלים בקשה כאשר יש מסמכים בעיבוד.";
  }

  const approvedDocuments = requestDocuments.filter((doc) => doc.status === "approved" && doc.requirementId);

  // Semantic requirement engine (src/lib/ai/requirementSemantics.ts): a
  // requirement with requiredCount > 1 needs that many units satisfied
  // against the office user's own stated meaning — see
  // src/lib/documentQuantity.ts. A requirement with no parsed spec resolves
  // to exactly the pre-semantic one-approved-document/distinct-period
  // check, unchanged. Multi-page continuation pages (continuationOfDocumentId
  // set) are never counted as their own unit.
  const unsatisfied = requirements.filter((requirement) => {
    const docs = approvedDocuments
      .filter((doc) => doc.requirementId === requirement.id && !doc.continuationOfDocumentId)
      .map((doc) => ({ periodLabel: doc.extractedPeriodLabel, personName: doc.extractedPersonName }));
    return !computeRequirementSatisfaction(requirement, docs).satisfied;
  });
  if (unsatisfied.length > 0) {
    return `יש ${unsatisfied.length} דרישות מסמכים שטרם אושרו.`;
  }

  return null;
}

// Human-review escalation (business policy: 3-day completion window, and
// max-2-deferrals-per-request — both implemented by scheduler.ts and
// reminderDeferral.ts respectively) — the single, shared entry point both
// callers use so the transition is atomic (CAS on status, never a
// select-then-update race) and the audit trail is consistent regardless of
// which trigger caused it. Reuses the pre-existing, previously-unused
// "escalated" status (see ALLOWED_TRANSITIONS above) rather than inventing
// a new one. Returns false (no-op) if the request already left an
// automatable status — e.g. it just completed, or a concurrent caller (or
// tick) already escalated it — so a caller never double-fires its own
// side effects (a client-facing message, a second audit row) for the same
// escalation.
export async function escalateToHumanReview(
  organizationId: string,
  collectionRequestId: string,
  reason: string,
  actorType: "system" | "client"
): Promise<boolean> {
  const db = await getDb();
  const claimed = await db
    .update(collectionRequests)
    .set({ status: "escalated", escalationReason: reason, reviewDeadlineAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, ["active", "waiting_for_client", "processing"])
      )
    )
    .returning({ id: collectionRequests.id });
  if (claimed.length === 0) return false;

  await recordAuditEvent({
    organizationId,
    eventType: "collection_request.escalated",
    description: reason,
    actorType,
    collectionRequestId,
  });
  return true;
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

  // Human-review escalation policy — every entry into "waiting_for_client"
  // (the very first time, a reopen, or an employee manually un-escalating)
  // starts a fresh 3-day review window and a fresh 2-deferral allowance,
  // regardless of which of this function's three call sites triggered it.
  // A deferral granted *within* an existing waiting_for_client episode
  // (reminderDeferral.ts) never calls applyTransition — it only extends
  // reviewDeadlineAt and increments deferralCount directly — so this reset
  // only ever fires once per fresh episode, never mid-episode.
  const reviewDeadlineAt =
    nextStatus === "waiting_for_client" ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : current.reviewDeadlineAt;
  const deferralCount = nextStatus === "waiting_for_client" ? 0 : current.deferralCount;

  await db
    .update(collectionRequests)
    .set({
      status: nextStatus,
      updatedAt: new Date(),
      completedAt: nextStatus === "completed" ? new Date() : current.completedAt,
      reviewDeadlineAt,
      deferralCount,
      escalationReason: nextStatus === "escalated" ? current.escalationReason : null,
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
    // Milestone 6 (Observe, removal side) — deliberately after the
    // Learning Mode check above, since detectMissingRequirements reads
    // the just-updated flag: a client's very first completion must never
    // trigger a "missing" suggestion, and by the time this runs, that
    // flag already reflects the truth for this exact transition.
    await detectMissingRequirements(organizationId, current.clientId, current.serviceId);
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

// Milestone 6: snapshots this client's *effective* requirement list — the
// service template, minus any of this client's confirmed removals, plus
// any of this client's confirmed additions
// (src/lib/clientDocumentProfile.ts) — not the raw template directly.
// Every pre-Milestone-6 client (with no confirmed profile changes at all)
// resolves to exactly the template, byte-for-byte identical to before.
export async function snapshotServiceRequirements(
  collectionRequestId: string,
  serviceId: string,
  organizationId: string,
  clientId: string
) {
  const db = await getDb();
  const effective = await resolveEffectiveRequirementNames(organizationId, clientId, serviceId);

  if (effective.length === 0) return;

  // Semantic requirement engine — a bare month-only period ("06" for
  // "יוני") in the reusable template only becomes a concrete "MM/YYYY" now,
  // anchored to this specific request's own creation moment (see
  // resolveExplicitPeriodsForSnapshot's own doc comment: a template has no
  // request date of its own to anchor a year to).
  const now = new Date();
  await db.insert(collectionRequestRequirements).values(
    effective.map((requirement) => {
      const templateSpec = requirement.semanticSpec as RequirementSemanticSpec | null;
      const snapshotSpec: RequirementSemanticSpec | null = templateSpec
        ? { ...templateSpec, explicitPeriods: resolveExplicitPeriodsForSnapshot(templateSpec.explicitPeriods, now) }
        : null;
      return {
        collectionRequestId,
        sourceRequirementId: requirement.sourceRequirementId,
        name: requirement.name,
        description: requirement.description,
        requiredCount: requirement.requiredCount,
        semanticSpec: snapshotSpec,
      };
    })
  );
}
