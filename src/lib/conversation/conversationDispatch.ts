import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { respondToPendingConfirmationManually } from "@/lib/pendingConfirmations";
import { applyClarificationReply } from "@/lib/documentIntakeReview";
import { attemptFinishCollectionRequest } from "@/lib/caseReview";
import { applyDeferralIfAny } from "@/lib/reminderDeferral";
import { answerRequestMessage, buildRequirementFacts } from "@/lib/requestQnA";
import { askWhichDocumentMissing, openRequirementException, resolveExceptionTarget } from "@/lib/requirementException";
import { addContextNoteToReviewItem, closeReviewItemFromClientContext, handlePotentialReviewQuestion } from "@/lib/employeeReview";
import { buildConversationContext } from "@/lib/conversation/conversationContext";
import { applyAnswersPendingClassification, applyCorrectsResolvedClassification } from "@/lib/correction/correctionDispatch";
import { classifyConversationIntent } from "@/lib/conversation/conversationIntent";
import type { ReviewItemAction } from "@/lib/conversation/conversationIntent";

/**
 * The unified document-conversation understanding layer's dispatcher — the
 * single entry point the webhook route calls for every inbound text
 * message once the purely-mechanical numbered-batched-reply check has
 * already had its (narrow) chance. Every existing "real" resolver in this
 * codebase (pending-confirmation resolution, the correction layer,
 * requirement exceptions, Q&A, deferral, finish) is reused here as the
 * EXECUTION layer — this module only decides *which* one to run and
 * *on what*, from real understanding of the message in full context,
 * never from keyword matching.
 *
 * The `handled` return value distinguishes "actively did something
 * (including sending a clarification)" (true) from "found nothing to act
 * on, stayed silent" (false, for "unrelated" only). In the main ladder
 * there is nothing left to fall through to either way. At the
 * post-completion-gate call site, `handled:false` matters: it lets that
 * gate fall through to its own (coarser) classifyReopenIntent check,
 * exactly like the old correction-only layer's "not_applicable" did.
 */

const MIN_ACT_CONFIDENCE = 0.65;
// Closing a review item automatically is irreversible from the client's
// point of view (the office won't independently re-check it) — deliberately
// the highest confidence bar in this whole layer, matching the explicit
// "never guess a closure" requirement. Adding a note is safe/reversible/
// purely additive, so it can act at the same bar as everything else here.
const REVIEW_ITEM_CLOSE_CONFIDENCE = 0.85;
const REVIEW_ITEM_NOTE_CONFIDENCE = 0.6;

function buildUnclearClarification(openQuestion: { question: string } | null): string {
  return openQuestion
    ? `לא הבנתי בבירור אם זו תשובה לשאלה ששאלתי ("${openQuestion.question}") או משהו אחר — אפשר להבהיר?`
    : "לא הצלחתי להבין בדיוק למה התכוונת — אפשר לנסח מחדש?";
}

function buildReviewItemFallbackAcknowledgment(action: ReviewItemAction): string {
  return action === "close_resolved" ? "מעולה, תודה שעדכנת." : "תודה, רשמתי את זה לתשומת לב הצוות.";
}

// The same "never trust a stale snapshot" discipline every other legal-
// outcomes table in this codebase uses (see correctionDispatch.ts's own
// legalOutcomesForDocument): what the AI is even allowed to propose depends
// on the item's real, current status, re-validated here — never on
// whatever the classifier assumed while it was reading the context.
function legalOutcomesForReviewItem(status: "pending" | "resolved"): Set<ReviewItemAction> {
  return status === "pending" ? new Set(["close_resolved", "add_context_note"]) : new Set(["add_context_note"]);
}

export async function runConversationUnderstanding(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  messageText: string;
}): Promise<{ handled: boolean }> {
  const context = await buildConversationContext({
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
  });
  const classification = await classifyConversationIntent(context, params.messageText);

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "message.conversation_intent_classified",
    description: `הודעת הלקוח סווגה כ-${classification.kind} (ביטחון ${classification.confidence.toFixed(2)})`,
    actorType: "ai",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { kind: classification.kind, confidence: classification.confidence },
  });

  if (classification.kind === "unrelated") {
    // Safe default: no reply, no state change. Reported as handled:false
    // (not "nothing to act on" != "actively handled") — this matters at
    // the post-completion-gate call site, which falls through to its own
    // classifyReopenIntent check only when this layer didn't claim the
    // message; the main-ladder call site ignores the return value either
    // way (there's nothing left to fall through to there).
    return { handled: false };
  }

  if (classification.kind === "unclear") {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(context.openQuestion), "ai", "manual", undefined, true);
    return { handled: true };
  }

  if (classification.kind === "resolves_pending") {
    if (!context.openQuestion) {
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
      return { handled: true };
    }
    if (context.openQuestion.kind === "document_clarification") {
      if (classification.confidence < MIN_ACT_CONFIDENCE) {
        await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(context.openQuestion), "ai", "manual", undefined, true);
        return { handled: true };
      }
      const resolved = await respondToPendingConfirmationManually(params.organizationId, context.openQuestion.id, true);
      if (!resolved) {
        await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(context.openQuestion), "ai", "manual", undefined, true);
        return { handled: true };
      }
      await applyClarificationReply(resolved, params.messageText);
      await recordAuditEvent({
        organizationId: params.organizationId,
        eventType: "pending_confirmation.resolved",
        description: `הלקוח הבהיר לגבי המסמך: "${params.messageText}"`,
        actorType: "client",
        clientId: params.clientId,
        collectionRequestId: params.collectionRequestId,
        metadata: { kind: resolved.kind, status: resolved.status },
      });
      return { handled: true };
    }
    return applyAnswersPendingClassification({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      openQuestionId: context.openQuestion.id,
      answer: classification.pendingAnswer,
      confidence: classification.confidence,
    });
  }

  if (classification.kind === "corrects_resolved") {
    return applyCorrectsResolvedClassification(params, context, {
      targetType: classification.correctionTargetType,
      targetId: classification.correctionTargetId,
      desiredOutcome: classification.correctionDesiredOutcome,
      confidence: classification.confidence,
    });
  }

  if (classification.kind === "reports_missing_document") {
    if (classification.confidence < MIN_ACT_CONFIDENCE) {
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
      return { handled: true };
    }
    const facts = await buildRequirementFacts(params.collectionRequestId);
    const outstanding = facts.filter((f) => !f.satisfied).map((f) => ({ id: f.id, name: f.description }));
    const target = resolveExceptionTarget(outstanding, classification.missingDocumentMentionedType);
    if (target.kind === "matched") {
      await openRequirementException({
        organizationId: params.organizationId,
        clientId: params.clientId,
        conversationId: params.conversationId,
        collectionRequestId: params.collectionRequestId,
        requirementId: target.requirementId,
        clientWording: params.messageText,
      });
    } else if (target.kind === "ambiguous") {
      await askWhichDocumentMissing({ organizationId: params.organizationId, conversationId: params.conversationId });
    }
    // "none_outstanding" — nothing is actually missing right now; stay
    // silent rather than open an exception against nothing.
    return { handled: true };
  }

  if (classification.kind === "needs_employee_review") {
    await handlePotentialReviewQuestion({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      clientQuestion: params.messageText,
      category: classification.reviewCategory ?? "other",
      relatedRequirementId: null,
      understoodContext: { relatedRequirementName: null, gist: classification.reviewGist ?? params.messageText },
    });
    return { handled: true };
  }

  if (classification.kind === "resolves_review_item") {
    const target = context.reviewItems.find((r) => r.id === classification.reviewItemTargetId) ?? null;
    if (!target) {
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
      return { handled: true };
    }

    const action = classification.reviewItemAction;
    const legal = legalOutcomesForReviewItem(target.status);
    if (!action || !legal.has(action) || classification.confidence < (action === "close_resolved" ? REVIEW_ITEM_CLOSE_CONFIDENCE : REVIEW_ITEM_NOTE_CONFIDENCE)) {
      // Ambiguous, or an action no longer legal for the item's real current
      // status (e.g. already resolved by an employee in the meantime) —
      // the item stays exactly as-is, never guessed shut.
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
      return { handled: true };
    }

    const acknowledgment = classification.naturalAcknowledgment?.trim() || buildReviewItemFallbackAcknowledgment(action);
    if (action === "close_resolved") {
      await closeReviewItemFromClientContext({
        organizationId: params.organizationId,
        reviewItemId: target.id,
        triggerMessage: params.messageText,
        reason: classification.reviewItemReason ?? "הלקוח מסר מידע חדש שפתר את השאלה.",
        clientAcknowledgment: acknowledgment,
      });
    } else {
      await addContextNoteToReviewItem({
        organizationId: params.organizationId,
        reviewItemId: target.id,
        triggerMessage: params.messageText,
        note: classification.reviewItemReason ?? params.messageText,
        clientAcknowledgment: acknowledgment,
      });
    }
    return { handled: true };
  }

  if (classification.kind === "asks_document_question") {
    const answer = await answerRequestMessage(classification.documentQuestionCategory ?? "request_overview", params.collectionRequestId);
    await sendOutboundMessage(params.organizationId, params.conversationId, answer, "ai", "manual", undefined, true);
    return { handled: true };
  }

  if (classification.kind === "finished_signal") {
    if (classification.confidence < MIN_ACT_CONFIDENCE) {
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
      return { handled: true };
    }
    await attemptFinishCollectionRequest({
      organizationId: params.organizationId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      clientId: params.clientId,
      actorType: "client",
    });
    return { handled: true };
  }

  if (classification.kind === "deferral_promise") {
    const promised = await applyDeferralIfAny({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      collectionRequestId: params.collectionRequestId,
      clientId: params.clientId,
      replyText: params.messageText,
    });
    if (!promised) {
      // The top-level classifier committed to "this looks like a promise",
      // but the specialized (and more precise) internal re-check disagreed —
      // the client still deserves a reply, never silence, given the general
      // classifier's own confident read.
      await sendOutboundMessage(params.organizationId, params.conversationId, buildUnclearClarification(null), "ai", "manual", undefined, true);
    }
    return { handled: true };
  }

  // Defensive-only: an unrecognized/malformed kind (e.g. a stale or
  // hand-mocked value in a test) never falls through to any state-changing
  // action — the safe default is silence, same as "unrelated".
  console.warn("[conversation-dispatch] unrecognized classification kind, treating as unrelated", { kind: classification.kind });
  return { handled: true };
}
