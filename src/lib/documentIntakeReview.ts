import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, conversations, documents, organizations, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import {
  AUTO_APPROVE_CONFIDENCE,
  type DocumentClassification,
  matchTextToCandidates,
  resolveRequirementAssignment,
} from "@/lib/ai/documentClassifier";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { isWithinBusinessHours, nextBusinessOpenTime, type BusinessHoursConfig } from "@/lib/businessHours";
import {
  createPendingConfirmation,
  flushDueIntakeNotifications,
  formatQuestionWithOptions,
  type PendingConfirmationKind,
} from "@/lib/pendingConfirmations";
import { fileExtension, uploadDocumentResiliently } from "@/lib/storage/driveAdapter";
import { scheduleAfterResponse } from "@/lib/scheduleAfterResponse";
import { CASE_REVIEW_SILENCE_WINDOW_MS, scheduleCaseReviewRelay } from "@/lib/caseReview";

/**
 * Ch.6's 3-way document intake split. A document the AI genuinely cannot
 * place is not automatically the same thing as a document that doesn't
 * need a human at all — the two were collapsed into one needs_review
 * bucket before this, which is exactly the bug this fixes:
 *
 *   1. Matched — identified and answers an open requirement. No human
 *      involved (existing behavior, untouched).
 *   2. Unsolicited — identified with real confidence, but doesn't answer
 *      anything currently open (e.g. an invoice, while only "תעודת זהות"
 *      is outstanding). The client — not an employee — is asked whether
 *      it was sent on purpose.
 *   3. Unrecognized — the AI couldn't tell what it even is. The client is
 *      asked to say, in their own words, what they sent.
 *
 * needs_review is reached only as a last resort: the client didn't answer
 * either question after the configured number of reminders, or something
 * failed outright. Never as the immediate response to "doesn't match."
 */

export const MIN_IDENTIFICATION_CONFIDENCE = 0.6;

export type DocumentIntakeOutcome =
  | { kind: "matched"; requirementId: string; confidence: number }
  | { kind: "unsolicited"; documentType: string }
  // A document that isn't usable as received — either a real image-quality
  // defect (reason "unreadable_quality": blurry, cropped, damaged...) or the
  // AI genuinely couldn't tell what it is at all (reason "unrecognized").
  // Unlike "unsolicited" (a genuine business question — "did you mean to
  // send this?" — that can wait for the whole-case review), this always
  // gets an immediate reply while the client is still in the chat and can
  // actually resend something. See processInboundAttachment
  // (conversationActions.ts) for where that immediate send happens, and
  // buildResendGuidanceMessage below for how its wording is composed.
  | {
      kind: "needs_resend";
      reason: "unreadable_quality" | "unrecognized";
      suspectedDocumentType: string | null;
      issueDetail: string | null;
      aiClientMessage: string | null;
    };

// The single decision point every real classification result (deterministic
// filename heuristic, learned pattern, or real AI vision result) funnels
// through. Only ever reads the AI's own identified/aiDocumentType signal —
// never re-derives it — so this stays a pure, easily-tested function.
export function resolveDocumentIntakeOutcome(
  classification: DocumentClassification,
  outstandingRequirementIds: string[]
): DocumentIntakeOutcome {
  // A real image-quality defect always needs a resend, however confident
  // the AI otherwise was about the type or match — a blurry ID card must
  // never be silently auto-approved just because the AI could still guess
  // what it probably was. Checked first, ahead of every other signal.
  if (classification.readabilityIssue) {
    return {
      kind: "needs_resend",
      reason: "unreadable_quality",
      suspectedDocumentType: classification.aiDocumentType ?? classification.suspectedDocumentType ?? null,
      issueDetail: classification.readabilityIssueDetail ?? null,
      aiClientMessage: classification.clientMessageIfProblematic ?? null,
    };
  }

  // A match only counts once it clears the same bar auto-approval always
  // required (a weak filename-token overlap, e.g. 0.3, was never enough on
  // its own) — below it, this falls through exactly like no match at all,
  // rather than landing directly in needs_review the way it used to.
  if (classification.matchedRequirementId && classification.confidence >= AUTO_APPROVE_CONFIDENCE) {
    return { kind: "matched", requirementId: classification.matchedRequirementId, confidence: classification.confidence };
  }

  // The AI positively identified this as something else — never let the
  // sole-outstanding-requirement fallback below silently override that;
  // that fallback exists for genuine ambiguity, not to second-guess a
  // confident "this isn't what you asked for."
  if (classification.aiRan && classification.aiIdentified && classification.aiDocumentType) {
    return { kind: "unsolicited", documentType: classification.aiDocumentType };
  }

  // No positive AI signal either way (no real file content to look at, or
  // the AI genuinely couldn't tell) — the existing sole-outstanding
  // fallback: with only one requirement still open, a newly-received file
  // can only be answering that one question.
  const fallback = resolveRequirementAssignment(classification, outstandingRequirementIds);
  if (fallback.requirementId && fallback.confidence >= AUTO_APPROVE_CONFIDENCE) {
    return { kind: "matched", requirementId: fallback.requirementId, confidence: fallback.confidence };
  }

  return {
    kind: "needs_resend",
    reason: "unrecognized",
    suspectedDocumentType: classification.suspectedDocumentType ?? null,
    issueDetail: null,
    aiClientMessage: classification.clientMessageIfProblematic ?? null,
  };
}

// Deterministic Hebrew label per category — used only as a fallback when
// the AI didn't craft its own clientMessageIfProblematic (e.g. the
// pre-vision filename gate, which has no image to reason about at all), so
// the client is never left with a bare "couldn't read it" regardless of
// which path produced this outcome.
const READABILITY_ISSUE_LABELS: Record<NonNullable<DocumentClassification["readabilityIssue"]>, string> = {
  blurry: "התמונה מטושטשת מדי לקריאה ברורה",
  cropped_or_incomplete: "רק חלק מהמסמך נראה בתמונה",
  too_dark_or_low_quality: "איכות התמונה נמוכה מדי לקריאה ברורה",
  damaged: "נראה שהמסמך פגום",
  wrong_orientation: "התמונה מסובבת ולא ניתנת לקריאה כך",
  other: "לא הצלחתי לקרוא את המסמך בבירור",
};

// The client-facing message for a "needs_resend" outcome — prefers the
// AI's own crafted wording (grounded in what it actually saw in the image,
// per documentVisionClassifier.ts's guardrails) and only falls back to a
// deterministic template when none is available. Never asks "did you mean
// to send this?" — that's not the relevant question for a technical
// defect or an unidentifiable file.
export function buildResendGuidanceMessage(
  outcome: Extract<DocumentIntakeOutcome, { kind: "needs_resend" }>
): string {
  if (outcome.aiClientMessage) return outcome.aiClientMessage;

  const typeNote = outcome.suspectedDocumentType ? `שנראה כמו ${outcome.suspectedDocumentType} ` : "";
  const issueNote =
    outcome.issueDetail ??
    (outcome.reason === "unreadable_quality" ? READABILITY_ISSUE_LABELS.other : "לא הצלחתי לזהות בוודאות איזה מסמך זה");
  // "המסמך האחרון ששלחת" already unambiguously refers to the file the
  // client just sent — never a storage filename (documents.fileName is a
  // WhatsApp-media-id-derived internal key, never something to show a
  // client — see src/lib/documents/displayLabel.ts).
  return `קיבלתי את המסמך האחרון ששלחת ${typeNote}— ${issueNote}. אפשר לשלוח שוב צילום ברור ומלא?`;
}

export async function getConfirmationReminderConfig(
  organizationId: string
): Promise<{ reminderIntervalDays: number; maxReminders: number; groupingWindowSeconds: number }> {
  const db = await getDb();
  const [org] = await db
    .select({
      reminderIntervalDays: organizations.reminderIntervalDays,
      confirmationMaxReminders: organizations.confirmationMaxReminders,
      documentGroupingWindowSeconds: organizations.documentGroupingWindowSeconds,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    reminderIntervalDays: org?.reminderIntervalDays ?? 2,
    maxReminders: org?.confirmationMaxReminders ?? 2,
    groupingWindowSeconds: org?.documentGroupingWindowSeconds ?? 15,
  };
}

// Org-level business hours only (no per-service override lookup here — a
// pending confirmation's payload doesn't carry a serviceId). Used only as a
// pre-check to decide whether to even attempt a reminder send; the real,
// authoritative gate (which does resolve per-service overrides) still runs
// inside sendOutboundMessage itself, so a mismatch here only ever costs a
// skipped attempt this tick, never an incorrectly-sent one.
async function getOrganizationBusinessHours(organizationId: string): Promise<BusinessHoursConfig> {
  const db = await getDb();
  const [org] = await db
    .select({
      businessHoursStart: organizations.businessHoursStart,
      businessHoursEnd: organizations.businessHoursEnd,
      businessDays: organizations.businessDays,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    businessHoursStart: org?.businessHoursStart ?? "09:00",
    businessHoursEnd: org?.businessHoursEnd ?? "18:00",
    businessDays: org?.businessDays ?? "0,1,2,3,4",
    timezone: org?.timezone ?? "Asia/Jerusalem",
  };
}

// Smart notification grouping: several unsolicited documents of the exact
// same type arriving in a short burst (e.g. two invoices) must read as one
// short question, not one per file. Short, warm wording — no legal/formal
// phrasing, no restating the original request. documentType is always
// whatever the AI actually identified the document as (never hardcoded).
function buildUnsolicitedQuestion(documentType: string, count: number): string {
  if (count === 1) {
    return `📄 ${documentType}\nלא היה חלק מהמסמכים שביקשתי.\n\nהאם שלחת אותו בכוונה?`;
  }
  return `📄 ${count} מסמכים מסוג ${documentType}\nלא היו חלק מהמסמכים שביקשתי.\n\nהאם שלחת אותם בכוונה?`;
}

// Case 2 (unsolicited): "did you mean to send this?" — a yes/no question,
// resolved by pendingConfirmations.ts's generic resolveConfirmationFromReply
// (see the webhook route) and applied by applyUnsolicitedConfirmationDecision
// below. Never uploads or touches document counts until the client answers.
export async function createUnsolicitedDocumentConfirmation(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string;
  documentType: string;
}): Promise<void> {
  const db = await getDb();

  // Smart notification grouping: several unsolicited documents of the same
  // type arriving in a short burst (e.g. two invoices) must fold into the
  // same still-unnotified group instead of each opening its own question —
  // this is what actually stops the client being flooded with near-
  // identical messages. Only ever merges into a group that hasn't been
  // sent yet (notifiedAt IS NULL); once a question has gone out, a later
  // document of the same type starts (or joins) a fresh group instead of
  // silently rewriting a message the client may already be reading.
  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, params.collectionRequestId),
        eq(pendingConfirmations.kind, "unsolicited_document" satisfies PendingConfirmationKind),
        eq(pendingConfirmations.status, "pending"),
        isNull(pendingConfirmations.notifiedAt)
      )
    );
  const existing = openRows.find(
    (row) => (row.payload as { documentType?: string } | null)?.documentType === params.documentType
  );

  if (existing) {
    const payload = existing.payload as { documentIds: string[]; documentType: string };
    const documentIds = [...payload.documentIds, params.documentId];
    await db
      .update(pendingConfirmations)
      .set({
        payload: { documentIds, documentType: params.documentType },
        question: buildUnsolicitedQuestion(params.documentType, documentIds.length),
      })
      .where(eq(pendingConfirmations.id, existing.id));
    console.log("[document-intake] unsolicited document merged into existing pending confirmation", {
      pendingConfirmationId: existing.id,
      collectionRequestId: params.collectionRequestId,
      documentCount: documentIds.length,
    });
    return;
  }

  console.log("[document-intake] pending confirmation created (unsolicited_document)", {
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    documentId: params.documentId,
    documentType: params.documentType,
  });

  const { groupingWindowSeconds } = await getConfirmationReminderConfig(params.organizationId);
  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "unsolicited_document" satisfies PendingConfirmationKind,
    payload: { documentIds: [params.documentId], documentType: params.documentType },
    question: buildUnsolicitedQuestion(params.documentType, 1),
    notifyAfter: new Date(Date.now() + groupingWindowSeconds * 1000),
  });

  // The actual send trigger — see flushDueIntakeNotifications's own doc
  // comment for why a lazy "next document" check and the cron backstop
  // alone were not enough (a burst with nothing arriving after it was
  // never flushed at all, a real production regression). Scheduled only
  // here, on the group's creation — a document that merges into this group
  // later doesn't need its own timer, this one still covers it.
  scheduleAfterResponse(async () => {
    await new Promise((resolve) => setTimeout(resolve, groupingWindowSeconds * 1000));
    await flushDueIntakeNotifications(params.organizationId, params.collectionRequestId);
  });
}

// Case 3 (unrecognized): open-ended — resolved by
// resolveOpenClarificationReply + applyClarificationReply below, never by
// the generic yes/no resolver.
export async function createClarificationRequest(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string;
  // Immediate problematic-document handling — processInboundAttachment
  // (conversationActions.ts) passes the real, specific
  // buildResendGuidanceMessage wording for a document it's asking about
  // right now. Left unset only by runCaseReview's own call, which handles
  // whatever's left over from before this document reached intake at all
  // (there is no richer wording available for those any more, since they
  // were never routed through resolveDocumentIntakeOutcome's needs_resend
  // branch to begin with).
  question?: string;
}): Promise<void> {
  const { reminderIntervalDays } = await getConfirmationReminderConfig(params.organizationId);
  const question = params.question ?? "לא הצלחתי לזהות את המסמך שקיבלתי 🤔\nאיזה מסמך זה? אפשר גם לשלוח צילום ברור יותר.";

  console.log("[document-intake] pending confirmation created (document_clarification)", {
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    documentId: params.documentId,
  });

  // Same reasoning as createUnsolicitedDocumentConfirmation above.
  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "document_clarification" satisfies PendingConfirmationKind,
    payload: { documentId: params.documentId },
    question,
    reminderIntervalDays,
    trigger: "manual",
    allowFreeform: true,
  });
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
}

// Applies the client's yes/no answer to an "was this intentional?"
// question. A no-op for any other confirmation kind — safe to call
// unconditionally alongside applyDocumentProfileConfirmation on whatever
// resolveConfirmationFromReply returns.
export async function applyUnsolicitedConfirmationDecision(resolved: ResolvedConfirmationRow): Promise<void> {
  if (resolved.kind !== ("unsolicited_document" satisfies PendingConfirmationKind)) return;
  // documentId (singular) is read as a fallback only for a row created
  // before smart notification grouping switched this payload to
  // documentIds (plural) — safe to remove once no such row can still be
  // pending in production.
  const payload = resolved.payload as { documentIds?: string[]; documentId?: string; documentType?: string } | null;
  const documentIds = payload?.documentIds ?? (payload?.documentId ? [payload.documentId] : []);
  if (documentIds.length === 0) return;
  const documentType = payload?.documentType ?? "מסמך נוסף";

  const db = await getDb();

  if (resolved.status === "declined") {
    // Sent by mistake: never uploaded, never counted, temp bytes cleared
    // per retention policy — nothing left behind. Applies to every
    // document in this group — a group is only ever created from
    // documents that share the exact same anomaly, so one decision is
    // always meant to cover all of them.
    for (const documentId of documentIds) {
      await db
        .update(documents)
        .set({ status: "unsolicited_rejected", pendingFileContent: null, pendingFileMimeType: null, updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await recordAuditEvent({
        organizationId: resolved.organizationId,
        eventType: "document.unsolicited_rejected",
        description: `הלקוח ציין שהמסמך "${documentType}" נשלח בטעות — לא הועלה ל-Drive`,
        actorType: "client",
        clientId: resolved.clientId,
        collectionRequestId: resolved.collectionRequestId,
        metadata: { documentId },
      });
    }
    console.log("[document-intake] confirmation resolved: declined, no upload", {
      documentIds,
      collectionRequestId: resolved.collectionRequestId,
    });

    // A short, immediate acknowledgment — the client explicitly said this
    // was a mistake, which deserves a direct reaction just like the
    // question that prompted it (matches every other immediate-reply
    // kind: needs_resend, identity_anomaly's own confirmed/declined
    // sends). Distinct from the "confirmed" branch below, which stays
    // fully quiet since there's nothing to acknowledge — the document was
    // simply accepted, exactly like any other ordinary document.
    await sendOutboundMessage(
      resolved.organizationId,
      resolved.conversationId,
      "בסדר, המסמך לא ייכלל.",
      "ai",
      "manual",
      undefined,
      true
    );

    // Still real activity on the request — arms the same 2-minute
    // silence-window summary trigger ordinary document arrivals use, so
    // the client still gets the normal "here's what's received/missing"
    // summary afterward (which never mentions this declined document —
    // computeCaseStatusLists only ever looks at approved/unsolicited_approved
    // documents).
    await db
      .update(conversations)
      .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
      .where(eq(conversations.id, resolved.conversationId));
    scheduleAfterResponse(() =>
      scheduleCaseReviewRelay({
        organizationId: resolved.organizationId,
        conversationId: resolved.conversationId,
        collectionRequestId: resolved.collectionRequestId,
        clientId: resolved.clientId,
      })
    );
    return;
  }

  if (resolved.status !== "confirmed") return;

  for (const documentId of documentIds) {
    const [doc] = await db
      .select({
        fileName: documents.fileName,
        pendingFileContent: documents.pendingFileContent,
        pendingFileMimeType: documents.pendingFileMimeType,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc) continue;

    // A readable name from what the AI actually identified it as — never
    // the meaningless WhatsApp-generated filename — reusing uploadDocument's
    // existing fallback-to-fileName + anti-overwrite logic unchanged; it
    // never gets a requirementId (there is none to assign), so the rename
    // has to happen here instead of via the requirement-name lookup path.
    const targetFileName = `${documentType}${fileExtension(doc.fileName)}`;
    await db
      .update(documents)
      .set({ status: "unsolicited_approved", fileName: targetFileName, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    // Every document in the group keeps its own independent audit trail
    // entry, even though one client answer covers the whole group.
    await recordAuditEvent({
      organizationId: resolved.organizationId,
      eventType: "document.unsolicited_approved",
      description: `הלקוח אישר שהמסמך "${documentType}" נשלח בכוונה — נשמר כמסמך נוסף בתיקיית הלקוח`,
      actorType: "client",
      clientId: resolved.clientId,
      collectionRequestId: resolved.collectionRequestId,
      metadata: { documentId },
    });

    // Same client folder every other approved document for this request
    // uses (ensureCollectionRequestDriveFolder) — never a new one, per
    // product requirement.
    await uploadDocumentResiliently(
      resolved.organizationId,
      resolved.clientId,
      documentId,
      targetFileName,
      resolved.collectionRequestId,
      doc.pendingFileContent ?? undefined,
      doc.pendingFileMimeType ?? undefined
    );
    console.log("[document-intake] confirmation resolved: confirmed, uploaded to Drive", {
      documentId,
      collectionRequestId: resolved.collectionRequestId,
      targetFileName,
    });
  }

  // A short immediate acknowledgment — the client answered a direct
  // question and deserves confirmation the system understood, exactly
  // like the "declined" branch above. This is NOT the full status summary
  // (still 2 minutes away, below) — just a receipt. The document itself
  // still folds into that later summary, labeled as "not requested" (see
  // buildCaseStatusSummaryMessage/computeCaseStatusLists, caseReview.ts).
  // Same exact wording as identity_anomaly's own confirmed branch
  // (documentIdentityVerification.ts) — the two questions/reasons stay
  // separate, only the post-"yes" behavior is unified.
  await sendOutboundMessage(
    resolved.organizationId,
    resolved.conversationId,
    "תודה! שמרתי את המסמך.",
    "ai",
    "manual",
    undefined,
    true
  );

  await db
    .update(conversations)
    .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
    .where(eq(conversations.id, resolved.conversationId));
  scheduleAfterResponse(() =>
    scheduleCaseReviewRelay({
      organizationId: resolved.organizationId,
      conversationId: resolved.conversationId,
      collectionRequestId: resolved.collectionRequestId,
      clientId: resolved.clientId,
    })
  );
}

// Applies the client's free-text answer to "what document is this?" — a
// no-op for any other confirmation kind. Re-classifies using the client's
// own words the same way a filename is classified (short free text behaves
// exactly like a filename for token-overlap purposes): a match resolves
// exactly like Case 1 (assign, approve, upload); no match falls through to
// Case 2 (ask whether it was intentional, using the client's own words as
// the identified type) rather than ever guessing.
export async function applyClarificationReply(resolved: ResolvedConfirmationRow, replyText: string): Promise<void> {
  if (resolved.kind !== ("document_clarification" satisfies PendingConfirmationKind)) return;
  const payload = resolved.payload as { documentId?: string } | null;
  const documentId = payload?.documentId;
  if (!documentId) return;

  const db = await getDb();
  const [doc] = await db
    .select({
      fileName: documents.fileName,
      pendingFileContent: documents.pendingFileContent,
      pendingFileMimeType: documents.pendingFileMimeType,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) return;

  await recordAuditEvent({
    organizationId: resolved.organizationId,
    eventType: "document.clarification_received",
    description: `הלקוח הבהיר לגבי המסמך: "${replyText}"`,
    actorType: "client",
    clientId: resolved.clientId,
    collectionRequestId: resolved.collectionRequestId,
    metadata: { documentId, reply: replyText },
  });

  const requirements = await db
    .select({ id: collectionRequestRequirements.id, name: collectionRequestRequirements.name })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, resolved.collectionRequestId));

  // matchTextToCandidates, not classifyDocument — the client's reply is a
  // short free-text description ("תעודת זהות שלי"), not a filename, and
  // has no extension for classifyDocument's file gate to accept.
  const textMatch = matchTextToCandidates(replyText, requirements);
  const matchedRequirement = requirements.find((r) => r.id === textMatch?.id);

  if (matchedRequirement) {
    const targetFileName = `${matchedRequirement.name}${fileExtension(doc.fileName)}`;
    await db
      .update(documents)
      .set({
        status: "approved",
        requirementId: matchedRequirement.id,
        fileName: targetFileName,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    await uploadDocumentResiliently(
      resolved.organizationId,
      resolved.clientId,
      documentId,
      targetFileName,
      resolved.collectionRequestId,
      doc.pendingFileContent ?? undefined,
      doc.pendingFileMimeType ?? undefined
    );
    console.log("[document-intake] clarification resolved: matched requirement, uploaded to Drive", {
      documentId,
      collectionRequestId: resolved.collectionRequestId,
      requirementId: matchedRequirement.id,
    });

    await sendOutboundMessage(
      resolved.organizationId,
      resolved.conversationId,
      `תודה על ההבהרה! שמרתי את זה כ${matchedRequirement.name}.`,
      "ai",
      "manual",
      undefined,
      true
    );
    return;
  }

  // Still doesn't match anything requested — the client's own description
  // becomes the "identified type" for the same unsolicited-confirmation
  // flow Case 2 uses, rather than guessing or dropping straight to
  // needs_review.
  await createUnsolicitedDocumentConfirmation({
    organizationId: resolved.organizationId,
    clientId: resolved.clientId,
    collectionRequestId: resolved.collectionRequestId,
    documentId,
    documentType: replyText,
  });
}

// The cron pass (wired into src/lib/scheduler.ts): resends the question for
// every due, unanswered unsolicited_document/document_clarification
// confirmation, or — once the organization's confirmationMaxReminders is
// reached with no reply — escalates the linked document to needs_review
// and stops reminding. needs_review here is explicitly "no reply after N
// reminders," never "didn't match a requirement" (see the audit event
// description below, distinct from document.classified's own wording).
export async function sendConfirmationRemindersAndEscalate(
  organizationId: string
): Promise<{ reminded: number; escalated: number }> {
  const db = await getDb();
  const { reminderIntervalDays, maxReminders } = await getConfirmationReminderConfig(organizationId);
  const businessHours = await getOrganizationBusinessHours(organizationId);

  const due = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.organizationId, organizationId),
        eq(pendingConfirmations.status, "pending"),
        isNull(pendingConfirmations.escalatedAt),
        isNotNull(pendingConfirmations.nextReminderAt),
        lte(pendingConfirmations.nextReminderAt, new Date())
      )
    );

  let reminded = 0;
  let escalated = 0;

  for (const row of due) {
    // Atomic claim (Phase 4.5 remediation) — nulls out nextReminderAt via
    // compare-and-swap against the exact value this row was just read
    // with, BEFORE deciding whether to escalate/defer/send. Two concurrent
    // scheduler ticks can then never both act on the same due confirmation
    // — whichever tick's UPDATE commits second matches zero rows and backs
    // off, exactly the pattern flushDueIntakeNotifications (this file) and
    // the scheduler's own deferred-reminder/case-review passes already
    // use. Every branch below is responsible for setting nextReminderAt
    // back to whatever its own outcome implies (a real future due date, or
    // left null for an escalation) — "sent:false" (the automation gate
    // blocked it, not a real send attempt) is the one path that must
    // restore the ORIGINAL due value, or this confirmation would silently
    // never be retried again.
    const claimed = await db
      .update(pendingConfirmations)
      .set({ nextReminderAt: null })
      .where(and(eq(pendingConfirmations.id, row.id), eq(pendingConfirmations.nextReminderAt, row.nextReminderAt!)))
      .returning({ id: pendingConfirmations.id });
    if (claimed.length === 0) continue; // lost the race to another tick

    if (row.remindersSent >= maxReminders) {
      // Every payload shape this cron pass has ever needed to escalate:
      // document_clarification carries a single documentId;
      // unsolicited_document carries documentIds (plural, smart
      // notification grouping); identity_anomaly
      // (documentIdentityVerification.ts) carries a `documents` array with
      // per-document type labels. Escalating means every document tied to
      // this unanswered question moves to needs_review, not just the first
      // one.
      const payload = row.payload as
        | { documentId?: string; documentIds?: string[]; documents?: Array<{ id: string }> }
        | null;
      const documentIds =
        payload?.documentIds ??
        payload?.documents?.map((d) => d.id) ??
        (payload?.documentId ? [payload.documentId] : []);
      for (const documentId of documentIds) {
        await db
          .update(documents)
          .set({ status: "needs_review", updatedAt: new Date() })
          .where(eq(documents.id, documentId));
      }
      await db
        .update(pendingConfirmations)
        .set({ escalatedAt: new Date(), nextReminderAt: null })
        .where(eq(pendingConfirmations.id, row.id));
      await recordAuditEvent({
        organizationId,
        eventType: "pending_confirmation.escalated_no_reply",
        description: `הלקוח לא הגיב לאחר ${row.remindersSent} תזכורות — הועבר לבדיקת עובד (לא בגלל אי-התאמה לדרישה)`,
        actorType: "system",
        clientId: row.clientId,
        collectionRequestId: row.collectionRequestId,
        metadata: { pendingConfirmationId: row.id, kind: row.kind },
      });
      escalated += 1;
      continue;
    }

    // BR-18.1 / product requirement: an automatic reminder never goes out
    // while the office is closed — and, critically, a reminder that becomes
    // due while closed isn't just silently retried on whatever tick happens
    // to run next (which, with a once-daily cron, could itself always land
    // outside business hours and never send at all — a real gap this closes).
    // Reschedule it to the next real business-hours opening instead, and
    // skip the send attempt entirely this tick.
    if (!isWithinBusinessHours(businessHours)) {
      await db
        .update(pendingConfirmations)
        .set({ nextReminderAt: nextBusinessOpenTime(businessHours) })
        .where(eq(pendingConfirmations.id, row.id));
      console.log("[document-intake] reminder deferred to next business-hours opening", {
        pendingConfirmationId: row.id,
        deferredTo: nextBusinessOpenTime(businessHours).toISOString(),
      });
      continue;
    }

    // Unlike the immediate question/thank-you sends above, a reminder can
    // legitimately go out days later — trigger stays "automated" (still
    // respects business hours, same as every other scheduler-driven send)
    // and the 24h session window may well have closed by then. allowFreeform
    // is still required (no pre-approved template exists for this dynamic
    // text) but Meta may reject the delivery outside the window; that
    // failure surfaces as a normal deliveryStatus:"failed" on the message
    // row (see sendViaWhatsApp), not a crash — a disclosed, accepted
    // limitation rather than a silent gap.
    // unsolicited_document/identity_anomaly questions carry numbered
    // yes/no options assigned at flush time (groupIndex) — the resend must
    // reconstruct them, since row.question itself is just the descriptive
    // statement (see formatQuestionWithOptions). document_clarification is
    // open-ended and was never given options to begin with.
    const resendBody =
      row.kind === ("document_clarification" satisfies PendingConfirmationKind)
        ? `רק תזכורת קטנה 🙂\n${row.question}`
        : `רק תזכורת קטנה 🙂\n${formatQuestionWithOptions(row.question, row.groupIndex)}`;
    const { sent } = await sendOutboundMessage(
      organizationId,
      row.conversationId,
      resendBody,
      "ai",
      "automated",
      undefined,
      true
    );
    console.log("[document-intake] reminder send attempt", {
      pendingConfirmationId: row.id,
      kind: row.kind,
      gatedSent: sent,
    });
    if (sent) {
      await db
        .update(pendingConfirmations)
        .set({
          remindersSent: row.remindersSent + 1,
          nextReminderAt: new Date(Date.now() + reminderIntervalDays * 24 * 60 * 60 * 1000),
        })
        .where(eq(pendingConfirmations.id, row.id));
      reminded += 1;
    } else {
      // The automation gate blocked the send (org/service paused) —
      // restore the original due date so this confirmation stays "due" and
      // is retried on the next tick, rather than being silently claimed
      // (nextReminderAt left null) and never reminded again.
      await db
        .update(pendingConfirmations)
        .set({ nextReminderAt: row.nextReminderAt })
        .where(eq(pendingConfirmations.id, row.id));
    }
  }

  return { reminded, escalated };
}

// The other cron pass smart notification grouping needs (wired into
// src/lib/scheduler.ts alongside sendConfirmationRemindersAndEscalate
// above): the backstop for a batch that has no further document arriving
// after it to trigger the lazy flush processInboundAttachment does on
// every call. Without this, a single burst of anomalies followed by
// silence would hold its question forever — this is what guarantees it
// still goes out once the grouping window elapses, bounded only by how
// often the external scheduler actually calls /api/cron/tick.
export async function flushDueIntakeNotificationsForOrganization(
  organizationId: string
): Promise<{ flushed: number }> {
  const db = await getDb();
  const rows = await db
    .select({ collectionRequestId: pendingConfirmations.collectionRequestId })
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.organizationId, organizationId),
        eq(pendingConfirmations.status, "pending"),
        isNull(pendingConfirmations.notifiedAt)
      )
    );
  const uniqueRequestIds = [...new Set(rows.map((row) => row.collectionRequestId))];

  let flushed = 0;
  for (const collectionRequestId of uniqueRequestIds) {
    const result = await flushDueIntakeNotifications(organizationId, collectionRequestId);
    if (result.sent) flushed += 1;
  }
  return { flushed };
}
