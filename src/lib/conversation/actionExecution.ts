import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { respondToPendingConfirmationManually } from "@/lib/pendingConfirmations";
import { applyClarificationReply } from "@/lib/documentIntakeReview";
import { attemptFinishCollectionRequest } from "@/lib/caseReview";
import { applyDeferralIfAny } from "@/lib/reminderDeferral";
import { buildRequirementFacts } from "@/lib/requestQnA";
import { askWhichDocumentMissing, openRequirementException, resolveExceptionTarget } from "@/lib/requirementException";
import { addContextNoteToReviewItem, closeReviewItemFromClientContext } from "@/lib/employeeReview";
import { applyAnswersPendingClassification, applyCorrectsResolvedClassification } from "@/lib/correction/correctionDispatch";
import { recordAuditEvent } from "@/lib/audit";
import type { ConversationContext } from "@/lib/conversation/conversationContext";
import type { ActionContract } from "@/lib/conversation/conversationReasoning";

/**
 * Phase 3 (conversation-intelligence redesign) — the ONLY place an
 * ActionContract (the reasoning layer's proposal) turns into a real DB
 * mutation. Deliberately a separate module from conversationUnderstanding.ts
 * (which decides the outcome) — no LLM output reaches here without having
 * already passed through a full reasoning call and, for anything the
 * reference resolver touched, its own real-id validation. This layer adds
 * ONE more round of validation specific to each action kind (matching
 * exactly what conversationDispatch.ts's existing branches already check
 * today) before ever calling a real handler.
 *
 * Reuses every existing trusted handler verbatim
 * (applyAnswersPendingClassification, applyCorrectsResolvedClassification,
 * applyClarificationReply, openRequirementException, askWhichDocumentMissing,
 * closeReviewItemFromClientContext, addContextNoteToReviewItem,
 * attemptFinishCollectionRequest, applyDeferralIfAny) — none of them are
 * modified or reimplemented. Not wired into route.ts/conversationDispatch.ts
 * in this phase; conversationDispatch.ts's own near-identical logic is left
 * completely untouched (deliberate duplication of the thin validation/glue
 * layer, not the handlers themselves — the same precedent
 * correctionDispatch.ts's own applyResolvedConfirmationOutcome already
 * documents for exactly this situation: never touch an already-working
 * branch for a change like this).
 */

const MIN_ACT_CONFIDENCE = 0.65;
const REVIEW_ITEM_CLOSE_CONFIDENCE = 0.85;
const REVIEW_ITEM_NOTE_CONFIDENCE = 0.6;

function buildUnclearClarification(openQuestion: { question: string } | null): string {
  return openQuestion
    ? `לא הבנתי בבירור אם זו תשובה לשאלה ששאלתי ("${openQuestion.question}") או משהו אחר — אפשר להבהיר?`
    : "לא הצלחתי להבין בדיוק למה התכוונת — אפשר לנסח מחדש?";
}

function buildReviewItemFallbackAcknowledgment(action: "close_resolved" | "add_context_note"): string {
  return action === "close_resolved" ? "מעולה, תודה שעדכנת." : "תודה, רשמתי את זה לתשומת לב הצוות.";
}

// Mirrors conversationDispatch.ts's own (private) legalOutcomesForReviewItem
// — small and pure enough to duplicate rather than export/couple the two
// modules together; same "never trust a stale snapshot" discipline: what
// the reasoning layer is even allowed to propose depends on the item's
// real, current status, re-validated here.
function legalOutcomesForReviewItem(status: "pending" | "resolved"): Set<"close_resolved" | "add_context_note"> {
  return status === "pending" ? new Set(["close_resolved", "add_context_note"]) : new Set(["add_context_note"]);
}

async function unclear(organizationId: string, conversationId: string, openQuestion: { question: string } | null) {
  await sendOutboundMessage(organizationId, conversationId, buildUnclearClarification(openQuestion), "ai", "manual", undefined, true);
  return { handled: true };
}

export async function validateAndExecuteAction(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  messageText: string;
  action: ActionContract;
  confidence: number;
  context: ConversationContext;
}): Promise<{ handled: boolean }> {
  const { organizationId, clientId, collectionRequestId, conversationId, messageText, action, confidence, context } = params;

  if (action.kind === "resolve_clarification") {
    if (!context.openQuestion || context.openQuestion.kind !== "document_clarification") {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    if (action.openQuestionId !== context.openQuestion.id) {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    if (confidence < MIN_ACT_CONFIDENCE) {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    const resolved = await respondToPendingConfirmationManually(organizationId, context.openQuestion.id, true);
    if (!resolved) {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    await applyClarificationReply(resolved, action.replyText);
    await recordAuditEvent({
      organizationId,
      eventType: "pending_confirmation.resolved",
      description: `הלקוח הבהיר לגבי המסמך: "${action.replyText}"`,
      actorType: "client",
      clientId,
      collectionRequestId,
      metadata: { kind: resolved.kind, status: resolved.status },
    });
    return { handled: true };
  }

  if (action.kind === "resolve_pending") {
    if (!context.openQuestion || context.openQuestion.kind === "document_clarification") {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    if (action.openQuestionId !== context.openQuestion.id) {
      return unclear(organizationId, conversationId, context.openQuestion);
    }
    return applyAnswersPendingClassification({
      organizationId,
      clientId,
      collectionRequestId,
      conversationId,
      openQuestionId: context.openQuestion.id,
      answer: action.answer,
      confidence,
    });
  }

  if (action.kind === "correct_resolved") {
    return applyCorrectsResolvedClassification(
      { organizationId, clientId, collectionRequestId, conversationId },
      context,
      {
        targetType: action.targetType,
        targetId: action.targetId,
        desiredOutcome: action.desiredOutcome,
        confidence,
      }
    );
  }

  if (action.kind === "report_missing_document") {
    if (confidence < MIN_ACT_CONFIDENCE) {
      return unclear(organizationId, conversationId, null);
    }
    const facts = await buildRequirementFacts(collectionRequestId);
    const outstanding = facts.filter((f) => !f.satisfied).map((f) => ({ id: f.id, name: f.description }));
    const target = resolveExceptionTarget(outstanding, action.mentionedType);
    if (target.kind === "matched") {
      await openRequirementException({
        organizationId,
        clientId,
        conversationId,
        collectionRequestId,
        requirementId: target.requirementId,
        clientWording: messageText,
      });
    } else if (target.kind === "ambiguous") {
      await askWhichDocumentMissing({ organizationId, conversationId });
    }
    return { handled: true };
  }

  if (action.kind === "finish_request") {
    if (confidence < MIN_ACT_CONFIDENCE) {
      return unclear(organizationId, conversationId, null);
    }
    await attemptFinishCollectionRequest({ organizationId, collectionRequestId, conversationId, clientId, actorType: "client" });
    return { handled: true };
  }

  if (action.kind === "defer") {
    const promised = await applyDeferralIfAny({ organizationId, conversationId, collectionRequestId, clientId, replyText: action.replyText });
    if (!promised) {
      return unclear(organizationId, conversationId, null);
    }
    return { handled: true };
  }

  if (action.kind === "resolve_review_item") {
    const target = context.reviewItems.find((r) => r.id === action.reviewItemId) ?? null;
    if (!target) {
      return unclear(organizationId, conversationId, null);
    }
    const legal = legalOutcomesForReviewItem(target.status);
    const requiredConfidence = action.action === "close_resolved" ? REVIEW_ITEM_CLOSE_CONFIDENCE : REVIEW_ITEM_NOTE_CONFIDENCE;
    if (!legal.has(action.action) || confidence < requiredConfidence) {
      return unclear(organizationId, conversationId, null);
    }
    const acknowledgment = action.acknowledgment.trim() || buildReviewItemFallbackAcknowledgment(action.action);
    if (action.action === "close_resolved") {
      await closeReviewItemFromClientContext({
        organizationId,
        reviewItemId: target.id,
        triggerMessage: messageText,
        reason: action.reason || "הלקוח מסר מידע חדש שפתר את השאלה.",
        clientAcknowledgment: acknowledgment,
      });
    } else {
      await addContextNoteToReviewItem({
        organizationId,
        reviewItemId: target.id,
        triggerMessage: messageText,
        note: action.reason || messageText,
        clientAcknowledgment: acknowledgment,
      });
    }
    return { handled: true };
  }

  // Defensive-only — exhaustiveness is enforced by ActionContract's own
  // union at the type level; this only guards a malformed/mocked value.
  console.warn("[action-execution] unrecognized action kind, no mutation performed", { action });
  return { handled: true };
}
