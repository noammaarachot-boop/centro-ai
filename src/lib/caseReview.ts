import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, conversations, documents, pendingConfirmations } from "@/db/schema";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { flushDueIntakeNotifications } from "@/lib/pendingConfirmations";
import { createClarificationRequest, createUnsolicitedDocumentConfirmation } from "@/lib/documentIntakeReview";
import { createOrMergeIdentityAnomalyConfirmation, type IdentityAnomaly } from "@/lib/documentIdentityVerification";
import { completeCollectionRequest } from "@/lib/collectionRequestStateMachine";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";

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

// Quantity-aware (src/lib/documentQuantity.ts): a requirement asking for
// more than one unit ("3 תלושי שכר") that's only partly satisfied is named
// with how many are still needed, not just listed as flatly "missing" —
// e.g. "תלוש שכר (התקבלו 1 מתוך 3)" instead of losing that nuance entirely.
// A requirement with zero approved documents at all keeps the plain name,
// same wording as before this feature existed.
async function listMissingRequirementNames(collectionRequestId: string): Promise<string[]> {
  const db = await getDb();
  const requirements = await db
    .select({
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
      requiredCount: collectionRequestRequirements.requiredCount,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, collectionRequestId));
  const approvedDocs = await db
    .select({ requirementId: documents.requirementId, extractedPeriodLabel: documents.extractedPeriodLabel })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "approved")));

  const missing: string[] = [];
  for (const requirement of requirements) {
    const periodLabels = approvedDocs
      .filter((doc) => doc.requirementId === requirement.id)
      .map((doc) => doc.extractedPeriodLabel);
    const { satisfiedCount, satisfied } = computeRequirementSatisfaction(requirement.requiredCount, periodLabels);
    if (satisfied) continue;
    missing.push(
      satisfiedCount > 0 && requirement.requiredCount > 1
        ? `${requirement.name} (התקבלו ${satisfiedCount} מתוך ${requirement.requiredCount})`
        : requirement.name
    );
  }
  return missing;
}

function buildMissingRequirementsMessage(missing: string[]): string {
  if (missing.length === 1) {
    return `קיבלתי, תודה! עדיין חסר לי: ${missing[0]}.`;
  }
  return `קיבלתי, תודה! עדיין חסרים לי:\n${missing.map((name) => `• ${name}`).join("\n")}`;
}

export type FinishOutcome = "review_pending" | "missing_requirements" | "completed" | "blocked";

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
    .set({ status: "closed", updatedAt: new Date() })
    .where(eq(conversations.id, params.conversationId));

  return "completed";
}
