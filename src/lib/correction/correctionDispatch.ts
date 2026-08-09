import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, collectionRequests, conversations, documents, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage, reopenIfCompleted } from "@/lib/conversationOrchestration";
import { respondToPendingConfirmationManually } from "@/lib/pendingConfirmations";
import { applyDocumentProfileConfirmation } from "@/lib/clientDocumentProfile";
import { applyUnsolicitedConfirmationDecision } from "@/lib/documentIntakeReview";
import { applyIdentityAnomalyDecision } from "@/lib/documentIdentityVerification";
import { applyRequestReopenDecision } from "@/lib/requestReopen";
import { activateExtension, applyExtensionFinishedDecision } from "@/lib/requestExtension";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";
import { fileExtension, markDocumentWithdrawnInDrive, renameDocumentInDrive } from "@/lib/storage/driveAdapter";
import { CASE_REVIEW_SILENCE_WINDOW_MS, scheduleCaseReviewRelay } from "@/lib/caseReview";
import { scheduleAfterResponse } from "@/lib/scheduleAfterResponse";
import { reprocessHeldReopenDocument } from "@/app/(app)/collections/conversationActions";
import { buildConversationContext, type ConversationCandidateDocument, type ConversationContext } from "@/lib/conversation/conversationContext";
import { classifyCorrectionIntent, type CorrectionDesiredOutcome } from "@/lib/correction/correctionClassifier";

/**
 * Conversational correction layer — the only file that touches the DB or
 * WhatsApp for this feature. Everything else in src/lib/correction/ is a
 * pure function or a read-only query. See the plan this was built from
 * (deep-sniffing-umbrella) for the full rationale — the short version: a
 * client's message that refers to something already resolved (not just the
 * currently open question) previously had nowhere to go and was silently
 * dropped. This is additive — every existing resolver in the webhook route
 * keeps working exactly as before; this only engages once none of them
 * claimed the message.
 */

const ANSWER_CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_ACT_CONFIDENCE = 0.8;

function legalOutcomesForDocument(params: {
  status: string;
  hasKnownMatchedRequirementId: boolean;
}): Set<CorrectionDesiredOutcome> {
  switch (params.status) {
    case "approved":
      return new Set(["save_as_extra", "mark_withdrawn"]);
    case "unsolicited_approved":
      return new Set(["mark_withdrawn"]);
    case "identity_anomaly_confirmed":
      return params.hasKnownMatchedRequirementId
        ? new Set(["attach_to_requirement", "mark_withdrawn"])
        : new Set(["mark_withdrawn"]);
    default:
      // unsolicited_rejected / identity_anomaly_rejected / reopen_declined
      // (bytes already cleared, nothing to recover) and anything else
      // (already withdrawn/superseded, or a status this layer never
      // targets) — both handled by the caller with their own honest reply,
      // never a silent no-op.
      return new Set();
  }
}

function buildAmbiguousAnswerClarification(): string {
  return "לא הבנתי בבירור אם זו תשובה לשאלה ששאלתי — אפשר לענות כן/לא בבירור?";
}

function buildAmbiguousTargetClarification(candidateLabel: string): string {
  return `לא הבנתי בדיוק לאיזה מסמך זה מתייחס — התכוונת ל${candidateLabel}?`;
}

function buildInvalidOutcomeClarification(candidateLabel: string): string {
  return `לגבי ${candidateLabel} — מה בדיוק תרצה שנעשה איתו?`;
}

function buildBytesGoneReply(): string {
  return "המסמך שדחית בעבר לא נשמר אצלנו ואי אפשר לשחזר אותו — אפשר לשלוח אותו שוב.";
}

function buildAlreadyHandledReply(): string {
  return "כבר טיפלתי בזה קודם.";
}

function buildCorrectionAck(outcome: CorrectionDesiredOutcome): string {
  if (outcome === "attach_to_requirement") return "תודה על התיקון! עדכנתי וצירפתי את המסמך לדרישה.";
  if (outcome === "save_as_extra") return "תודה על התיקון! שמרתי את המסמך כמסמך נוסף בלבד.";
  return "תודה על התיקון! ביטלתי את המסמך.";
}

interface ResolvedConfirmationRow {
  id: string;
  kind: string;
  status: string;
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  payload: unknown;
  question: string;
}

// The exact same 5-call fan-out the webhook route's own `resolved` branch
// already runs (route.ts, "resolveConfirmationFromReply" success path) —
// duplicated here rather than extracted into a shared module, so the
// route's already-working branch is never touched by this change at all.
async function applyResolvedConfirmationOutcome(resolved: ResolvedConfirmationRow): Promise<void> {
  await applyDocumentProfileConfirmation(resolved);
  await applyUnsolicitedConfirmationDecision(resolved);
  await applyIdentityAnomalyDecision(resolved);
  await applyRequestReopenDecision(resolved, reprocessHeldReopenDocument);
  await applyExtensionFinishedDecision(resolved);
}

async function armCaseReviewTimer(params: {
  organizationId: string;
  conversationId: string;
  collectionRequestId: string;
  clientId: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .update(conversations)
    .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
    .where(eq(conversations.id, params.conversationId));
  scheduleAfterResponse(() => scheduleCaseReviewRelay(params));
}

// After a disposition that may have removed the document backing a
// `completed` request's last satisfied requirement: re-checks
// checkCompletionGate fresh, and if it no longer passes, auto-reopens via
// the exact existing completed->active pathway (reopenIfCompleted +
// activateExtension + conversations.status="open") — reused, never
// reinvented. Product decision: allowed to run fully automatically at the
// confidence level this whole layer already requires to act at all.
async function reopenIfNoLongerComplete(params: {
  organizationId: string;
  collectionRequestId: string;
  conversationId: string;
}): Promise<boolean> {
  const db = await getDb();
  const [request] = await db
    .select({ status: collectionRequests.status })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, params.collectionRequestId))
    .limit(1);
  if (request?.status !== "completed") return false;

  const gateError = await checkCompletionGate(params.collectionRequestId);
  if (gateError === null) return false; // still genuinely complete — nothing to reopen

  const reopened = await reopenIfCompleted(params.organizationId, params.collectionRequestId);
  if (reopened) {
    await db.update(conversations).set({ status: "open", updatedAt: new Date() }).where(eq(conversations.id, params.conversationId));
    await activateExtension(params.collectionRequestId);
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "collection_request.reopened_via_correction",
      description: "בקשה שכבר הושלמה נפתחה מחדש אוטומטית בעקבות תיקון של הלקוח למסמך שסיפק את הדרישה האחרונה",
      actorType: "system",
      collectionRequestId: params.collectionRequestId,
    });
  }
  return reopened;
}

async function applyDisposition(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  document: { id: string; fileName: string; requirementId: string | null; googleDriveFileId: string | null };
  outcome: CorrectionDesiredOutcome;
  matchedRequirementId: string | null;
  documentType: string | null;
}): Promise<void> {
  const db = await getDb();

  if (params.outcome === "mark_withdrawn") {
    await db
      .update(documents)
      .set({ status: "withdrawn_by_correction", updatedAt: new Date() })
      .where(eq(documents.id, params.document.id));
    if (params.document.googleDriveFileId) {
      await markDocumentWithdrawnInDrive(params.organizationId, params.document.googleDriveFileId, params.document.fileName);
    }
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "document.withdrawn_by_correction",
      description: "הלקוח תיקן החלטה קודמת וביקש לבטל את המסמך לגמרי",
      actorType: "client",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      metadata: { documentId: params.document.id },
    });
    return;
  }

  if (params.outcome === "save_as_extra") {
    const targetFileName = `${params.documentType ?? "מסמך נוסף"}${fileExtension(params.document.fileName)}`;
    await db
      .update(documents)
      .set({ status: "identity_anomaly_confirmed", requirementId: null, fileName: targetFileName, updatedAt: new Date() })
      .where(eq(documents.id, params.document.id));
    if (params.document.googleDriveFileId) {
      await renameDocumentInDrive(params.organizationId, params.document.googleDriveFileId, targetFileName);
    }
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "document.corrected_via_conversation",
      description: "הלקוח תיקן החלטה קודמת — המסמך יישאר כמסמך נוסף בלבד, לא כמענה לדרישה",
      actorType: "client",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      metadata: { documentId: params.document.id, targetFileName },
    });
    return;
  }

  // attach_to_requirement — never trusts a stale snapshot, same discipline
  // applyIdentityAnomalyDecision's own confirmed branch already uses.
  const requirementId = params.matchedRequirementId;
  if (!requirementId) return; // legalOutcomesForDocument already guards this — defensive only
  const [requirement] = await db
    .select({
      id: collectionRequestRequirements.id,
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.id, requirementId))
    .limit(1);
  let stillOpen = false;
  if (requirement) {
    const approvedSiblings = await db
      .select({
        extractedPeriodLabel: documents.extractedPeriodLabel,
        extractedPersonName: documents.extractedPersonName,
        continuationOfDocumentId: documents.continuationOfDocumentId,
      })
      .from(documents)
      .where(eq(documents.requirementId, requirementId));
    const satisfactionDocs = approvedSiblings
      .filter((d) => !d.continuationOfDocumentId)
      .map((d) => ({ periodLabel: d.extractedPeriodLabel, personName: d.extractedPersonName }));
    stillOpen = !computeRequirementSatisfaction(requirement, satisfactionDocs).satisfied;
  }

  if (!stillOpen) {
    // Something else already satisfied it in the meantime — fall back to
    // keeping it as an extra rather than forcing an already-closed
    // requirement, same fallback applyIdentityAnomalyDecision uses.
    await applyDisposition({ ...params, outcome: "save_as_extra" });
    return;
  }

  await db
    .update(documents)
    .set({ requirementId, status: "approved", updatedAt: new Date() })
    .where(eq(documents.id, params.document.id));
  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "document.corrected_via_conversation",
    description: "הלקוח תיקן החלטה קודמת — המסמך צורף כעת כמענה לדרישה",
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { documentId: params.document.id, requirementId },
  });
}

// Extracted so the unified conversation-understanding layer
// (src/lib/conversation/) can dispatch an already-classified
// "answers_open_question" decision without paying for a second AI
// classification call — this is exactly runCorrectionLayer's own former
// inline branch, unchanged in behavior, just callable directly with a
// pre-classified answer.
export async function applyAnswersPendingClassification(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  openQuestionId: string | null;
  answer: "confirm" | "decline" | null;
  confidence: number;
}): Promise<{ handled: true }> {
  if (!params.openQuestionId || params.confidence < ANSWER_CONFIDENCE_THRESHOLD || !params.answer) {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildAmbiguousAnswerClarification(), "ai", "manual", undefined, true);
    return { handled: true };
  }
  const resolved = await respondToPendingConfirmationManually(params.organizationId, params.openQuestionId, params.answer === "confirm");
  if (!resolved) {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildAmbiguousAnswerClarification(), "ai", "manual", undefined, true);
    return { handled: true };
  }
  await applyResolvedConfirmationOutcome(resolved as ResolvedConfirmationRow);
  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "pending_confirmation.resolved",
    description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} בקשת אישור (זוהה בהבנת הקשר): "${resolved.question}"`,
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { kind: resolved.kind, status: resolved.status, resolvedVia: "correction_layer" },
  });
  return { handled: true };
}

// Extracted for the same reason as applyAnswersPendingClassification above
// — runCorrectionLayer's former inline "corrects_resolved" branch,
// unchanged in behavior, callable with an already-built context and an
// already-classified decision shape.
export async function applyCorrectsResolvedClassification(
  params: {
    organizationId: string;
    clientId: string;
    collectionRequestId: string;
    conversationId: string;
  },
  context: ConversationContext,
  classification: {
    targetType: "document" | "confirmation" | null;
    targetId: string | null;
    desiredOutcome: CorrectionDesiredOutcome | null;
    confidence: number;
  }
): Promise<{ handled: boolean }> {
  if (!classification.targetType || !classification.targetId) {
    return { handled: false };
  }

  let liveDocument: ConversationCandidateDocument | null = null;
  let matchedRequirementId: string | null = null;

  if (classification.targetType === "document") {
    liveDocument = context.recentDocuments.find((d) => d.id === classification.targetId) ?? null;
  } else {
    const confirmation = context.recentResolvedConfirmations.find((c) => c.id === classification.targetId) ?? null;
    if (confirmation) {
      const db = await getDb();
      const [row] = await db
        .select({ payload: pendingConfirmations.payload })
        .from(pendingConfirmations)
        .where(eq(pendingConfirmations.id, confirmation.id))
        .limit(1);
      const payload = row?.payload as { documents?: Array<{ id: string; matchedRequirementId?: string | null }>; documentIds?: string[] } | null;
      const firstDocId = payload?.documents?.[0]?.id ?? payload?.documentIds?.[0] ?? null;
      matchedRequirementId = payload?.documents?.[0]?.matchedRequirementId ?? null;
      if (firstDocId) {
        liveDocument = context.recentDocuments.find((d) => d.id === firstDocId) ?? null;
        // Not necessarily in the candidate window (e.g. a confirmation
        // whose document is old but the confirmation itself is recent) —
        // fetch its live status/fields directly rather than skip it.
        if (!liveDocument) {
          const [docRow] = await db
            .select({
              id: documents.id,
              fileName: documents.fileName,
              requirementId: documents.requirementId,
              status: documents.status,
              extractedPersonName: documents.extractedPersonName,
              extractedCompanyName: documents.extractedCompanyName,
              receivedAt: documents.receivedAt,
            })
            .from(documents)
            .where(eq(documents.id, firstDocId))
            .limit(1);
          if (docRow) {
            liveDocument = {
              id: docRow.id,
              documentType: null,
              requirementName: null,
              extractedPersonName: docRow.extractedPersonName,
              extractedCompanyName: docRow.extractedCompanyName,
              status: docRow.status,
              receivedAt: docRow.receivedAt.toISOString(),
            };
          }
        }
      }
    }
  }

  if (!liveDocument) {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildAmbiguousTargetClarification("המסמך שציינת"), "ai", "manual", undefined, true);
    return { handled: true };
  }

  // Never trust the context snapshot's status — re-fetch live before any
  // mutation (the same discipline applyIdentityAnomalyDecision's confirmed
  // branch already uses).
  const db = await getDb();
  const [live] = await db
    .select({
      id: documents.id,
      fileName: documents.fileName,
      requirementId: documents.requirementId,
      status: documents.status,
      googleDriveFileId: documents.googleDriveFileId,
    })
    .from(documents)
    .where(eq(documents.id, liveDocument.id))
    .limit(1);
  if (!live) {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildAlreadyHandledReply(), "ai", "manual", undefined, true);
    return { handled: true };
  }

  const legal = legalOutcomesForDocument({
    status: live.status,
    hasKnownMatchedRequirementId: !!matchedRequirementId,
  });

  if (legal.size === 0) {
    const bytesGoneStatuses = new Set(["unsolicited_rejected", "identity_anomaly_rejected", "reopen_declined"]);
    const reply = bytesGoneStatuses.has(live.status) ? buildBytesGoneReply() : buildAlreadyHandledReply();
    await sendOutboundMessage(params.organizationId, params.conversationId, reply, "ai", "manual", undefined, true);
    return { handled: true };
  }

  const candidateLabel = liveDocument.documentType ?? "המסמך";
  if (!classification.desiredOutcome || !legal.has(classification.desiredOutcome) || classification.confidence < CORRECTION_ACT_CONFIDENCE) {
    await sendOutboundMessage(params.organizationId, params.conversationId, buildInvalidOutcomeClarification(candidateLabel), "ai", "manual", undefined, true);
    return { handled: true };
  }

  await applyDisposition({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    document: { id: live.id, fileName: live.fileName, requirementId: live.requirementId, googleDriveFileId: live.googleDriveFileId },
    outcome: classification.desiredOutcome,
    matchedRequirementId,
    documentType: liveDocument.documentType,
  });

  await sendOutboundMessage(params.organizationId, params.conversationId, buildCorrectionAck(classification.desiredOutcome), "ai", "manual", undefined, true);
  await armCaseReviewTimer(params);
  await reopenIfNoLongerComplete(params);

  return { handled: true };
}

export async function runCorrectionLayer(params: {
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
  const classification = await classifyCorrectionIntent(context, params.messageText);

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "message.correction_intent_classified",
    description: `הודעת הלקוח סווגה כ-${classification.kind} (ביטחון ${Number(classification.confidence ?? 0).toFixed(2)})`,
    actorType: "ai",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { kind: classification.kind, confidence: classification.confidence },
  });

  if (classification.kind === "not_applicable") {
    return { handled: false };
  }

  if (classification.kind === "answers_open_question") {
    return applyAnswersPendingClassification({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      openQuestionId: context.openQuestion?.id ?? null,
      answer: classification.answer,
      confidence: classification.confidence,
    });
  }

  // corrects_resolved
  return applyCorrectsResolvedClassification(params, context, classification);
}
