import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, collectionRequests, conversations, documents, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { flushDueIntakeNotifications } from "@/lib/pendingConfirmations";
import { createClarificationRequest, createUnsolicitedDocumentConfirmation } from "@/lib/documentIntakeReview";
import { createOrMergeIdentityAnomalyConfirmation, type IdentityAnomaly } from "@/lib/documentIdentityVerification";
import { completeCollectionRequest } from "@/lib/collectionRequestStateMachine";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";
import { classifyFollowUpIntent } from "@/lib/ai/conversationReplyIntent";

// Silence-window case review (runAutomaticCaseStatusReview, below) — how
// long a collection request's conversation must go without a new document
// before Centro proactively reports status, instead of requiring the
// client to ever say "סיימתי". Exported so the scheduler and its tests
// share one source of truth for the window length.
//
// Deliberately a different mechanism from the reminderIntervalDays-based
// staleness reminder (scheduler.ts's staleWaitingConversations pass): this
// one is a direct reaction to activity the client themselves just
// initiated (like the reactive document-intake questions, which already
// use "manual" trigger below), so it runs 24/7 with no business-hours
// gate — the client is demonstrably active *right now*, not being nudged
// out of nowhere. The separate reminder stays business-hours-gated.
export const CASE_REVIEW_SILENCE_WINDOW_MS = 2 * 60 * 1000;

/**
 * "Centro checks the case, not the document" — a document classified as an
 * identity anomaly, unsolicited, or unrecognized is never asked about the
 * moment it arrives; processInboundAttachment (conversationActions.ts)
 * just records deferredReviewKind/deferredReviewPayload on it and moves
 * on, silently, so the client is never interrupted mid-collection. This
 * module is what actually turns those deferred exceptions into a real
 * question — once, for the whole request together — the moment the
 * client signals they're done sending documents. It reuses the exact same
 * grouping/messaging infrastructure (createXConfirmation,
 * flushDueIntakeNotifications) a real-time exception would have used; the
 * only thing that changes is *when* it runs.
 */

// Phrases a client might use to say they're done sending documents.
// Deliberately narrow, lead-with matching (same discipline as
// pendingConfirmations.ts's YES_WORDS/NO_WORDS) — never guesses "finished"
// out of a longer, more ambiguous sentence (e.g. "עוד לא סיימתי" must
// never match).
const FINISHED_PHRASES = [
  "סיימתי",
  "סיימתי לשלוח",
  "זה הכל",
  "זהו",
  "זה כל המסמכים",
  "אלה כל המסמכים",
  "העליתי הכל",
  "העליתי את הכל",
  "שלחתי הכל",
  "שלחתי את הכל",
  "גמרתי",
  "finished",
  "that's all",
  "that's everything",
  "done",
];

export function isFinishedSignal(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  return FINISHED_PHRASES.some(
    (phrase) =>
      trimmed === phrase ||
      trimmed.startsWith(`${phrase} `) ||
      trimmed.startsWith(`${phrase}.`) ||
      trimmed.startsWith(`${phrase}!`)
  );
}

interface DeferredDocument {
  id: string;
  deferredReviewKind: string;
  deferredReviewPayload: unknown;
}

// Groups and asks about every document still holding a deferred review on
// this request, in one pass — reusing the exact same per-kind create/merge
// functions a real-time exception would have called, so the resulting
// grouping/wording/numbered-options behavior is identical, just deferred
// to this single moment instead of scattered across the whole collection
// window. A no-op (returns hasPendingReview: false) when nothing was ever
// deferred, which is the common case.
export async function runCaseReview(
  organizationId: string,
  clientId: string,
  collectionRequestId: string
): Promise<{ hasPendingReview: boolean; groupCount: number }> {
  const db = await getDb();
  const deferred = await db
    .select({
      id: documents.id,
      deferredReviewKind: documents.deferredReviewKind,
      deferredReviewPayload: documents.deferredReviewPayload,
    })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), isNotNull(documents.deferredReviewKind)));

  if (deferred.length === 0) {
    return { hasPendingReview: false, groupCount: 0 };
  }

  console.log("[case-review] reviewing whole case", {
    collectionRequestId,
    documentCount: deferred.length,
    kinds: deferred.map((d) => d.deferredReviewKind),
  });

  for (const doc of deferred as DeferredDocument[]) {
    if (doc.deferredReviewKind === "identity_anomaly") {
      const payload = doc.deferredReviewPayload as { anomaly: IdentityAnomaly; documentType: string | null };
      await createOrMergeIdentityAnomalyConfirmation({
        organizationId,
        clientId,
        collectionRequestId,
        documentId: doc.id,
        anomaly: payload.anomaly,
        documentType: payload.documentType,
      });
    } else if (doc.deferredReviewKind === "unsolicited_document") {
      const payload = doc.deferredReviewPayload as { documentType: string };
      await createUnsolicitedDocumentConfirmation({
        organizationId,
        clientId,
        collectionRequestId,
        documentId: doc.id,
        documentType: payload.documentType,
      });
    } else if (doc.deferredReviewKind === "document_clarification") {
      await createClarificationRequest({
        organizationId,
        clientId,
        collectionRequestId,
        documentId: doc.id,
      });
    }
    // Consumed — never re-reviewed if runCaseReview somehow runs again
    // (e.g. a duplicate "finished" message) before the client answers.
    await db
      .update(documents)
      .set({ deferredReviewKind: null, deferredReviewPayload: null })
      .where(eq(documents.id, doc.id));
  }

  // The grouping window's purpose is to catch a burst of *arriving*
  // documents; by the time the client says they're done, there's nothing
  // left to wait for — force every group just created straight to due
  // instead of waiting out its notifyAfter, then flush immediately.
  await db
    .update(pendingConfirmations)
    .set({ notifyAfter: new Date() })
    .where(
      and(eq(pendingConfirmations.collectionRequestId, collectionRequestId), isNotNull(pendingConfirmations.notifyAfter))
    );
  const flushResult = await flushDueIntakeNotifications(organizationId, collectionRequestId);

  return { hasPendingReview: true, groupCount: flushResult.groupCount };
}

interface CaseStatusLists {
  // Every requirement with at least one approved document, labeled with
  // progress when partially satisfied — e.g. "תלוש שכר (התקבלו 1 מתוך 3)"
  // — same annotation convention as `missing` below, so the two lists read
  // consistently side by side.
  received: string[];
  missing: string[];
}

// Quantity-aware (src/lib/documentQuantity.ts): shared core of both
// listMissingRequirementNames (below, unchanged public behavior) and the
// silence-window case summary (buildCaseStatusSummaryMessage) — one pass
// over every requirement, classifying each into `received`/`missing`
// (a partially-satisfied requirement appears in both, annotated with
// progress in each). Multi-page continuation pages never count as their
// own unit.
async function computeCaseStatusLists(collectionRequestId: string): Promise<CaseStatusLists> {
  const db = await getDb();
  const requirements = await db
    .select({
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, collectionRequestId));
  const approvedDocs = await db
    .select({
      requirementId: documents.requirementId,
      extractedPeriodLabel: documents.extractedPeriodLabel,
      extractedPersonName: documents.extractedPersonName,
      continuationOfDocumentId: documents.continuationOfDocumentId,
    })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "approved")));

  const received: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const docs = approvedDocs
      .filter((doc) => doc.requirementId === requirement.id && !doc.continuationOfDocumentId)
      .map((doc) => ({ periodLabel: doc.extractedPeriodLabel, personName: doc.extractedPersonName }));
    const { satisfiedCount, satisfied } = computeRequirementSatisfaction(requirement, docs);
    const progressSuffix =
      satisfiedCount > 0 && requirement.requiredCount > 1 ? ` (התקבלו ${satisfiedCount} מתוך ${requirement.requiredCount})` : "";
    if (satisfiedCount > 0) {
      received.push(`${requirement.name}${progressSuffix}`);
    }
    if (!satisfied) {
      missing.push(`${requirement.name}${progressSuffix}`);
    }
  }
  return { received, missing };
}

export async function listMissingRequirementNames(collectionRequestId: string): Promise<string[]> {
  return (await computeCaseStatusLists(collectionRequestId)).missing;
}

function buildMissingRequirementsMessage(missing: string[]): string {
  if (missing.length === 1) {
    return `קיבלתי, תודה! עדיין חסר לי: ${missing[0]}.`;
  }
  return `קיבלתי, תודה! עדיין חסרים לי:\n${missing.map((name) => `• ${name}`).join("\n")}`;
}

// The silence-window summary's own message — unlike
// buildMissingRequirementsMessage (a reply to the client's own "סיימתי"),
// this is a proactive report the client never asked for, so it names both
// what actually arrived and what's still outstanding rather than assuming
// "קיבלתי" context from a reply.
export function buildCaseStatusSummaryMessage(received: string[], missing: string[]): string {
  const parts: string[] = [];
  if (received.length > 0) {
    parts.push(
      received.length === 1
        ? `קיבלתי את המסמך הבא:\n• ${received[0]}`
        : `קיבלתי את המסמכים הבאים:\n${received.map((name) => `• ${name}`).join("\n")}`
    );
  }
  if (missing.length > 0) {
    parts.push(
      missing.length === 1
        ? `עדיין חסר לי:\n• ${missing[0]}`
        : `עדיין חסרים לי:\n${missing.map((name) => `• ${name}`).join("\n")}`
    );
  }
  return parts.join("\n\n");
}

export type FinishOutcome = "review_pending" | "missing_requirements" | "completed" | "blocked";

// Shared by both attemptFinishCollectionRequest (explicit "סיימתי") and
// runAutomaticCaseStatusReview (silence-window trigger, below) — the exact
// same completion send + conversation-close + deferral/extension cleanup
// either path needs the moment completeCollectionRequest actually succeeds.
async function finalizeCompletion(params: { organizationId: string; collectionRequestId: string; conversationId: string }): Promise<void> {
  await sendOutboundMessage(
    params.organizationId,
    params.conversationId,
    "מעולה, קיבלתי הכל! תודה 😊",
    "ai",
    "manual",
    undefined,
    true
  );

  const db = await getDb();
  await db
    .update(conversations)
    .set({
      status: "closed",
      updatedAt: new Date(),
      // Reminder deferral by explicit client commitment
      // (src/lib/reminderDeferral.ts) — a no-op for every completion that
      // never had one; when it was set, the request completing (even
      // before the deferred date arrives — the client sent everything
      // early) means there's nothing left to defer a reminder about.
      deferredReminderAt: null,
      // Silence-window case review — a no-op for every completion that
      // never had one pending; when it was set, the request completing
      // means there's nothing left to summarize.
      pendingCaseReviewAt: null,
    })
    .where(eq(conversations.id, params.conversationId));
  // Post-completion extension flow (src/lib/requestExtension.ts) — a no-op
  // for every ordinary (non-extension) completion, since it's already
  // false there. Cleared here, centrally, rather than at each of the
  // several places that can trigger a completion (an explicit "finished"
  // message, the extension-finished-check confirmation, the scheduler),
  // so none of them has to remember to do it themselves.
  await db
    .update(collectionRequests)
    .set({ extensionActive: false })
    .where(eq(collectionRequests.id, params.collectionRequestId));
}

// The single entry point for "the client is done sending documents" —
// used identically whether that came from the client's own WhatsApp text
// (the real, primary path) or an employee's dashboard button (kept for
// parity/manual override). Always reviews the whole case first: any
// exception found during collection gets asked about now, grouped, before
// anything else. Only once there's nothing left pending does it attempt
// to actually complete the request.
export async function attemptFinishCollectionRequest(params: {
  organizationId: string;
  collectionRequestId: string;
  conversationId: string;
  clientId: string;
  actorType: "client" | "employee";
}): Promise<FinishOutcome> {
  const { hasPendingReview } = await runCaseReview(params.organizationId, params.clientId, params.collectionRequestId);
  if (hasPendingReview) {
    return "review_pending";
  }

  const result = await completeCollectionRequest(
    params.organizationId,
    undefined,
    params.actorType,
    params.collectionRequestId
  );

  if (!result.ok) {
    const missing = await listMissingRequirementNames(params.collectionRequestId);
    if (missing.length === 0) {
      // Blocked for some other reason (e.g. a document still mid-upload
      // retry) — nothing concrete to tell the client yet, never guess.
      return "blocked";
    }
    await sendOutboundMessage(
      params.organizationId,
      params.conversationId,
      buildMissingRequirementsMessage(missing),
      "ai",
      "manual",
      undefined,
      true
    );
    return "missing_requirements";
  }

  await finalizeCompletion(params);
  return "completed";
}

export type CaseStatusReviewOutcome = "completed" | "review_pending" | "summary_sent" | "nothing_to_report";

// The silence-window counterpart to attemptFinishCollectionRequest — same
// underlying evaluation (review the whole case, then check completion),
// triggered by 5 minutes of document inactivity (the scheduler, via
// conversations.pendingCaseReviewAt) rather than the client ever typing
// "סיימתי". An ordinary active collection request has no dependency on
// that phrase at all anymore; it remains meaningful only for the separate
// post-completion extension flow (requestExtension.ts), which still asks
// its own "סיימת להעלות?" question because a completed request has no
// requirement list left to silently evaluate against.
//
// Held/ambiguous documents (deferredReviewKind) never block this from
// running: runCaseReview below already turns them into their own real
// question the moment AI genuinely couldn't resolve them — by definition
// the point they were deferred to begin with — so this function itself
// never needs a separate "still under review" placeholder line. When a
// question was just asked, that's this tick's entire output; the summary
// naturally follows on a later tick once the client replies (which resets
// the silence window like any other activity) or once nothing more is
// pending.
export async function runAutomaticCaseStatusReview(params: {
  organizationId: string;
  collectionRequestId: string;
  conversationId: string;
  clientId: string;
}): Promise<CaseStatusReviewOutcome> {
  const { hasPendingReview } = await runCaseReview(params.organizationId, params.clientId, params.collectionRequestId);
  if (hasPendingReview) {
    return "review_pending";
  }

  const result = await completeCollectionRequest(
    params.organizationId,
    undefined,
    "client",
    params.collectionRequestId
  );
  if (result.ok) {
    await finalizeCompletion(params);
    return "completed";
  }

  const { received, missing } = await computeCaseStatusLists(params.collectionRequestId);
  if (missing.length === 0) {
    // Blocked for some other reason (e.g. a document still mid-upload
    // retry) — nothing concrete to report yet, never guess.
    return "nothing_to_report";
  }
  // "manual" (same convention finalizeCompletion and every reactive
  // document-intake question already use) — this is a direct reaction to
  // the client's own just-happened activity, not a cold automated nudge,
  // so it always sends regardless of business hours/automation pause.
  await sendOutboundMessage(
    params.organizationId,
    params.conversationId,
    buildCaseStatusSummaryMessage(received, missing),
    "ai",
    "manual",
    undefined,
    true
  );
  return "summary_sent";
}

// Free-text "I'll send it later" understanding — called only when the
// client's message didn't resolve any open confirmation and wasn't a
// "finished" signal (see the webhook route / simulateInboundMessage), so
// this never competes with either. A real send-later promise
// ("אשלח בערב") sets conversations.nextFollowUpAt, which
// runScheduledTasks (scheduler.ts) checks before sending its stale-
// conversation reminder — a reminder must never go out before a time the
// client explicitly committed to. Returns whether a promise was actually
// recognized, purely for the caller's own logging.
export async function applyFollowUpPromiseIfAny(params: {
  organizationId: string;
  conversationId: string;
  collectionRequestId: string;
  clientId: string;
  replyText: string;
}): Promise<boolean> {
  const isFollowUpPromise = await classifyFollowUpIntent(params.replyText);
  if (!isFollowUpPromise) return false;

  // A short, human acknowledgment — never a reminder, never a question.
  // No explicit deferral bookkeeping is needed beyond this: the client's
  // own message already reset conversations.updatedAt (recordInboundMessage),
  // which is exactly what the scheduler's stale-conversation reminder
  // measures staleness against — see classifyFollowUpIntent's own doc
  // comment for why that alone is enough.
  await sendOutboundMessage(params.organizationId, params.conversationId, "בסדר, תודה 😊", "ai", "manual", undefined, true);

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "conversation.follow_up_promised",
    description: "הלקוח ציין שישלח מסמכים נוספים בהמשך",
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
  });
  return true;
}
