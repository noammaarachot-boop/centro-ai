import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
  employeeReviewItems,
} from "@/db/schema";
import { humanReviewDeadlineFrom } from "@/lib/attention/policy";
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

// Canonical "this request is still real, outstanding work" — every status
// except the two truly terminal ones. Used both to count a template's
// "active requests" (src/lib/data/templates.ts) and to decide whether
// sending a template to a client again would create a silent duplicate —
// the same one predicate for both, never two independently-drifting
// definitions. Deliberately includes "draft" (a genuinely queued/scheduled
// send, not yet delivered — see scheduledSend.ts) and "escalated" (still
// unresolved, just waiting on a human) — only completed/cancelled work is
// actually done.
export const NON_TERMINAL_STATUSES: CollectionRequestStatus[] = [
  "draft",
  "active",
  "waiting_for_client",
  "processing",
  "escalated",
];

// Canonical "the system is genuinely waiting on the client right now"
// condition — the exact OR the reminder scheduler (scheduler.ts's own
// staleWaitingConversations query) uses to decide whether a request is due
// for a nudge:
//   - conversations.status="waiting_for_client" AND
//     collectionRequests.status="waiting_for_client" — the client said
//     they're done and the system is waiting on their final confirmation.
//   - conversations.status="open" AND collectionRequests.status="active"
//     — the request never even reached that point: it's still missing
//     requirements and the client hasn't engaged (see scheduler.ts's own
//     "root-cause fix (2026-08-15)" comment for why this second branch
//     exists at all).
// Single source of truth: scheduler.ts imports and uses this directly in
// its own query (never re-declares the OR itself), and any other caller
// (e.g. a dashboard's own "waiting for client" count) must do the same —
// never re-derive an equivalent-looking condition independently, since
// that's exactly how a dashboard and the engine it's supposed to reflect
// can silently drift apart.
export function isWaitingForClientCondition(): SQL {
  return or(
    and(eq(conversations.status, "waiting_for_client"), eq(collectionRequests.status, "waiting_for_client")),
    and(eq(conversations.status, "open"), eq(collectionRequests.status, "active"))
  ) as SQL;
}

// BR-11.2: the request remains open until all required documents are
// received. BR-6.1: only validated (approved) documents satisfy a
// requirement. BR-6.2: documents still "processing" block completion.
export interface RequirementsProgress {
  // How many of the request's own requirements are, right now, genuinely
  // satisfied per computeRequirementSatisfaction — the same real algorithm
  // checkCompletionGate itself relies on. Never a document count, a
  // percentage guess, or any other stand-in.
  satisfiedCount: number;
  totalCount: number;
  unsatisfiedCount: number;
  // A document mid-AI-processing blocks completion outright (see
  // checkCompletionGate below) even though it isn't tied to any specific
  // requirement's satisfied/unsatisfied count — surfaced separately so a
  // caller (e.g. a dashboard) can distinguish "genuinely missing
  // documents" from "already sent, still being read by the system".
  hasProcessingDocuments: boolean;
  // The unsatisfied requirements' own names, in the same order they were
  // fetched — "what's missing" for a caller that wants to show it (e.g. a
  // template's active-requests list), computed from the exact same
  // per-requirement loop as satisfiedCount, never a second pass.
  missingRequirementNames: string[];
}

// Single source of truth for "how much of this request is actually done"
// — checkCompletionGate (below) and any other caller (e.g. a dashboard's
// own X/Y progress display) both call this one function, so there is
// never a second, possibly-diverging completion algorithm anywhere in the
// codebase. Reuses exactly the same fetch/loop checkCompletionGate always
// has; this is a pure extraction, not a behavior change.
export async function computeRequirementsProgress(
  collectionRequestId: string
): Promise<RequirementsProgress> {
  const byRequest = await computeRequirementsProgressBulk([collectionRequestId]);
  return byRequest.get(collectionRequestId) ?? EMPTY_PROGRESS;
}

const EMPTY_PROGRESS: RequirementsProgress = {
  satisfiedCount: 0,
  totalCount: 0,
  unsatisfiedCount: 0,
  hasProcessingDocuments: false,
  missingRequirementNames: [],
};

/**
 * The same algorithm, for many requests in two queries instead of 2N.
 *
 * A pure batching extraction, not a second definition: the per-requirement
 * loop below IS the one computeRequirementsProgress used to run inline, and
 * that function now delegates here. This exists because deriving attention
 * for a dashboard needs "is anything still missing" across every open request
 * at once, and doing that with a per-row call was the kind of cost that
 * tempts someone into writing a cheaper, subtly different SQL approximation
 * — which is exactly the drift this whole change is removing.
 */
export async function computeRequirementsProgressBulk(
  collectionRequestIds: string[]
): Promise<Map<string, RequirementsProgress>> {
  const result = new Map<string, RequirementsProgress>();
  if (collectionRequestIds.length === 0) return result;

  const db = await getDb();

  const requirements = await db
    .select({
      collectionRequestId: collectionRequestRequirements.collectionRequestId,
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
    })
    .from(collectionRequestRequirements)
    .where(inArray(collectionRequestRequirements.collectionRequestId, collectionRequestIds));

  const requestDocuments = await db
    .select({
      collectionRequestId: documents.collectionRequestId,
      requirementId: documents.requirementId,
      status: documents.status,
      extractedPeriodLabel: documents.extractedPeriodLabel,
      extractedPersonName: documents.extractedPersonName,
      continuationOfDocumentId: documents.continuationOfDocumentId,
    })
    .from(documents)
    .where(inArray(documents.collectionRequestId, collectionRequestIds));

  for (const collectionRequestId of collectionRequestIds) {
    const ownRequirements = requirements.filter((r) => r.collectionRequestId === collectionRequestId);
    const ownDocuments = requestDocuments.filter((d) => d.collectionRequestId === collectionRequestId);

    const hasProcessingDocuments = ownDocuments.some((doc) => doc.status === "processing");
    const approvedDocuments = ownDocuments.filter((doc) => doc.status === "approved" && doc.requirementId);

    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts): a
    // requirement with requiredCount > 1 needs that many units satisfied
    // against the office user's own stated meaning — see
    // src/lib/documentQuantity.ts. A requirement with no parsed spec resolves
    // to exactly the pre-semantic one-approved-document/distinct-period
    // check, unchanged. Multi-page continuation pages
    // (continuationOfDocumentId set) are never counted as their own unit.
    let satisfiedCount = 0;
    const missingRequirementNames: string[] = [];
    for (const requirement of ownRequirements) {
      const docs = approvedDocuments
        .filter((doc) => doc.requirementId === requirement.id && !doc.continuationOfDocumentId)
        .map((doc) => ({ periodLabel: doc.extractedPeriodLabel, personName: doc.extractedPersonName }));
      if (computeRequirementSatisfaction(requirement, docs).satisfied) {
        satisfiedCount += 1;
      } else {
        missingRequirementNames.push(requirement.name);
      }
    }

    result.set(collectionRequestId, {
      satisfiedCount,
      totalCount: ownRequirements.length,
      unsatisfiedCount: ownRequirements.length - satisfiedCount,
      hasProcessingDocuments,
      missingRequirementNames,
    });
  }

  return result;
}

export async function checkCompletionGate(
  collectionRequestId: string
): Promise<string | null> {
  const progress = await computeRequirementsProgress(collectionRequestId);

  if (progress.hasProcessingDocuments) {
    return "לא ניתן להשלים בקשה כאשר יש מסמכים בעיבוד.";
  }
  if (progress.unsatisfiedCount > 0) {
    return `יש ${progress.unsatisfiedCount} דרישות מסמכים שטרם אושרו.`;
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
  // Marks the request as needing a human WITHOUT touching where it is in its
  // life. status used to be overwritten with "escalated", which destroyed the
  // lifecycle value and forced a guess to get it back later; the request is
  // still waiting_for_client (or active), and now stays so.
  //
  // The claim is on escalatedAt being null rather than on a status value, so
  // a concurrent tick still cannot double-fire: whichever transaction sets it
  // first wins and the other sees zero rows.
  const claimed = await db
    .update(collectionRequests)
    .set({ escalatedAt: new Date(), escalationReason: reason, reviewDeadlineAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId),
        isNull(collectionRequests.escalatedAt),
        // A finished request is never escalated — that answer is already real.
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
  //
  // Explicit resend (2026-08-16) — "only an explicit resend reopens a new
  // lifecycle": an employee moving a request out of "escalated" back to
  // "active" (the automated-reminder track, not "waiting_for_client" —
  // this is the request-never-really-responded case, not the client-said-
  // done case above) is the one intentional, human-triggered action that
  // may restart the automation clock. Nothing else ever transitions a
  // request out of "escalated" automatically — the scheduler's own queries
  // exclude it entirely — so this branch can only ever fire from a real,
  // deliberate employee action (transitionStatus).
  const isExplicitResendFromEscalation = current.status === "escalated" && nextStatus === "active";
  const startsFreshCycle = nextStatus === "waiting_for_client" || isExplicitResendFromEscalation;
  // One policy, one place — this was a bare literal that had to be kept in
  // step by hand with the threshold the request card measured against.
  const reviewDeadlineAt = startsFreshCycle ? humanReviewDeadlineFrom(Date.now()) : current.reviewDeadlineAt;
  const deferralCount = startsFreshCycle ? 0 : current.deferralCount;

  // CAS on the status just read — closes the race window between the
  // SELECT above and this UPDATE (e.g. a scheduler tick moving the request
  // to "completed" a moment before an employee's cancel lands). Every
  // caller of applyTransition benefits, not just cancel — mirrors the
  // atomic-claim pattern escalateToHumanReview already uses.
  const updated = await db
    .update(collectionRequests)
    .set({
      status: nextStatus,
      updatedAt: new Date(),
      completedAt: nextStatus === "completed" ? new Date() : current.completedAt,
      reviewDeadlineAt,
      deferralCount,
      escalationReason: nextStatus === "escalated" ? current.escalationReason : null,
      // Post-completion extension flow (src/lib/requestExtension.ts) — a
      // no-op for every ordinary (non-extension) completion, since it's
      // already false there. Cleared centrally here (not just by
      // caseReview.ts's finalizeCompletion) so it's true of every path to
      // "completed", including a direct employee status change.
      extensionActive: nextStatus === "completed" ? false : current.extensionActive,
    })
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.status, current.status)
      )
    )
    .returning({ id: collectionRequests.id });
  if (updated.length === 0) {
    return { ok: false, error: "הבקשה כבר עודכנה בינתיים על ידי תהליך אחר. רעננו ונסו שוב." };
  }

  // Lifecycle closure invariant — "once a collection request is completed
  // OR cancelled, Centro stops engaging with that conversation entirely."
  // Centralized here (the one low-level function every path to either
  // terminal status already goes through) so it's structurally impossible
  // to reach either without also closing the conversation. The webhook
  // route's own `conversation.status === "closed"` gate (route.ts) is what
  // actually stops automation from here on; this is what guarantees that
  // gate sees the truth no matter which call site triggered the
  // transition. Cancelling reuses the exact same guard completed already
  // relies on rather than a parallel one.
  const entersTerminalClosedState = nextStatus === "completed" || nextStatus === "cancelled";
  if (entersTerminalClosedState) {
    await db
      .update(conversations)
      .set({
        status: "closed",
        updatedAt: new Date(),
        // A no-op for every completion/cancellation that never had one
        // pending; when set, there's nothing left to defer/summarize.
        deferredReminderAt: null,
        pendingCaseReviewAt: null,
      })
      .where(eq(conversations.collectionRequestId, collectionRequestId));

    // "אין להשאיר stale alerts או stale review items" — an employee
    // question that was still open when the request happened to complete
    // or get cancelled through some other path must not keep surfacing as
    // "needs attention" forever. Resolved, never deleted (audit trail
    // preserved via a distinct event type below, so a reader can tell this
    // wasn't an employee's own answer); no client-facing message is sent —
    // the request is already closed, and issue #4's invariant forbids any
    // further automated message on a closed conversation.
    const staleReviewItems = await db
      .update(employeeReviewItems)
      .set({
        status: "resolved",
        resolutionText:
          nextStatus === "completed"
            ? "הבקשה הושלמה — הפריט נסגר אוטומטית ללא תשובה נפרדת."
            : "הבקשה בוטלה — הפריט נסגר אוטומטית ללא תשובה נפרדת.",
        resolvedBy: "ai_context",
        resolvedByUserId: null,
        resolvedAt: new Date(),
      })
      .where(and(eq(employeeReviewItems.collectionRequestId, collectionRequestId), eq(employeeReviewItems.status, "pending")))
      .returning({ id: employeeReviewItems.id, clientQuestion: employeeReviewItems.clientQuestion });

    for (const item of staleReviewItems) {
      await recordAuditEvent({
        organizationId,
        eventType:
          nextStatus === "completed"
            ? "review_item.auto_resolved_by_completion"
            : "review_item.auto_resolved_by_cancellation",
        description:
          nextStatus === "completed"
            ? `הפריט "${item.clientQuestion}" נסגר אוטומטית — הבקשה הושלמה`
            : `הפריט "${item.clientQuestion}" נסגר אוטומטית — הבקשה בוטלה`,
        actorType: "system",
        collectionRequestId,
        metadata: { reviewItemId: item.id },
      });
    }
  }

  if (isExplicitResendFromEscalation) {
    // Same fresh start for the reminder side of the clock (conversations
    // table, untouched by the update above) — reminderAnchorAt anchors to
    // this resend, not the original (long-stale) send, and any leftover
    // deferral from before the escalation is cleared rather than
    // immediately re-suppressing the freshly-restarted reminders.
    await db
      .update(conversations)
      .set({ reminderAnchorAt: new Date(), deferredReminderAt: null })
      .where(eq(conversations.collectionRequestId, collectionRequestId));
  }

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

  // Dedicated event (in addition to the generic one above) — matches the
  // precedent of escalateToHumanReview's "collection_request.escalated"
  // and reopenIfCompleted's "collection_request.reopened": who cancelled
  // and when are already captured by this row's own actorType/actorUserId/
  // occurredAt (audit.ts), per the project's existing audit architecture —
  // no new columns needed.
  if (nextStatus === "cancelled") {
    await recordAuditEvent({
      organizationId,
      eventType: "collection_request.cancelled",
      description: "בקשת האיסוף בוטלה",
      actorType,
      actorUserId,
      clientId: current.clientId,
      collectionRequestId,
    });
  }

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
//
// Root-cause fix (2026-08-16 production incident — reminders silently
// stopped after a partial document arrived) — this used to transition to
// "processing" unconditionally BEFORE checking whether the request was
// actually complete, then attempt processing -> completed, which fails
// (via applyTransition's own gate check) whenever real requirements are
// still outstanding. The processing pre-transition was never rolled back
// on that failure, and "processing" has no legal transition back to
// "active" (see ALLOWED_TRANSITIONS) — so any request that reached this
// function while still genuinely incomplete (e.g. runAutomaticCaseStatusReview
// calling this after a partial document, or a client prematurely saying
// "finished") got permanently stranded in "processing": invisible to every
// scheduler pass that only queries "active"/"waiting_for_client". The
// caller-facing behavior (reporting exactly what's still missing) was
// unaffected, which is why this went unnoticed — only the request's own
// status silently broke. Checking the gate FIRST, before ever touching
// status, means an incomplete request is simply left exactly where it
// already was — still visible to reminders/evaluation — with the real
// missing-requirements error still returned to the caller unchanged.
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

  if (current.status === "completed") return { ok: true };

  if (current.status !== "processing") {
    const gateError = await checkCompletionGate(collectionRequestId);
    if (gateError) return { ok: false, error: gateError };

    const toProcessing = await applyTransition(
      organizationId,
      actorUserId,
      actorType,
      collectionRequestId,
      "processing"
    );
    if (!toProcessing.ok) return toProcessing;
  }

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

/**
 * Clears an escalation once a human has dealt with it.
 *
 * There is deliberately nothing to "restore" here. escalateToHumanReview no
 * longer overwrites status, so the lifecycle was never lost: the request has
 * been waiting_for_client (or active) the whole time and simply stays there.
 * The predecessor of this function had to reconstruct the old status by
 * guessing it back from the conversation, and a request whose escalation was
 * cleared by an older deploy is still sitting in production with the wrong
 * status because of it.
 *
 * Returns the escalation's occurrence instant so the caller can record a
 * dismissal against the exact escalation it just cleared, or null if there
 * was nothing escalated — already handled, or never escalated at all.
 */
export async function clearEscalation(
  organizationId: string,
  collectionRequestId: string
): Promise<Date | null> {
  const db = await getDb();

  // Tenant-scoped read of the exact escalation being cleared. Its instant is
  // the occurrence a dismissal is recorded against, so it has to be captured
  // before the clear — RETURNING would report the new (null) value.
  const [current] = await db
    .select({ escalatedAt: collectionRequests.escalatedAt })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!current?.escalatedAt) return null;
  const occurrence = current.escalatedAt;

  // Compare-and-swap on that exact instant, not merely on "is not null": if
  // the request was re-escalated between the read and the write, this clears
  // nothing rather than silently discarding an escalation the employee never
  // saw.
  const [cleared] = await db
    .update(collectionRequests)
    .set({
      escalatedAt: null,
      escalationReason: null,
      // A fresh episode starts, exactly as the old "employee moves it out of
      // escalated" transition did: the office has dealt with this, so the
      // request gets a full window again rather than being instantly overdue,
      // and the deferrals the client already used do not count against them
      // forever.
      reviewDeadlineAt: humanReviewDeadlineFrom(Date.now()),
      deferralCount: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.escalatedAt, occurrence)
      )
    )
    .returning({ id: collectionRequests.id });

  if (!cleared) return null;

  // Restart the reminder interval too, for the same reason the review window
  // restarts: without it the anchor is still the stale pre-escalation one, so
  // the very next tick would message the client the instant an employee
  // pressed "טופל" — which reads as the system arguing with them.
  await db
    .update(conversations)
    .set({ reminderAnchorAt: new Date(), deferredReminderAt: null })
    .where(
      and(
        eq(conversations.collectionRequestId, collectionRequestId),
        eq(conversations.organizationId, organizationId)
      )
    );

  return occurrence;
}
