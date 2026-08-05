import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, documents, organizations, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import {
  AUTO_APPROVE_CONFIDENCE,
  type DocumentClassification,
  matchTextToCandidates,
  resolveRequirementAssignment,
} from "@/lib/ai/documentClassifier";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import {
  createPendingConfirmation,
  type PendingConfirmationKind,
} from "@/lib/pendingConfirmations";
import { fileExtension, uploadDocumentResiliently } from "@/lib/storage/driveAdapter";

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
  | { kind: "unrecognized" };

// The single decision point every real classification result (deterministic
// filename heuristic, learned pattern, or real AI vision result) funnels
// through. Only ever reads the AI's own identified/aiDocumentType signal —
// never re-derives it — so this stays a pure, easily-tested function.
export function resolveDocumentIntakeOutcome(
  classification: DocumentClassification,
  outstandingRequirementIds: string[]
): DocumentIntakeOutcome {
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

  return { kind: "unrecognized" };
}

async function getConfirmationReminderConfig(
  organizationId: string
): Promise<{ reminderIntervalDays: number; maxReminders: number }> {
  const db = await getDb();
  const [org] = await db
    .select({
      reminderIntervalDays: organizations.reminderIntervalDays,
      confirmationMaxReminders: organizations.confirmationMaxReminders,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    reminderIntervalDays: org?.reminderIntervalDays ?? 2,
    maxReminders: org?.confirmationMaxReminders ?? 2,
  };
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
  const { reminderIntervalDays } = await getConfirmationReminderConfig(params.organizationId);
  const question = [
    `זיהינו ששלחת מסמך מסוג ${params.documentType}, אך מסמך זה לא נכלל כרגע ברשימת המסמכים שהתבקשת לשלוח.`,
    "האם שלחת אותו בכוונה?",
    "1. כן, שלחתי בכוונה",
    "2. לא, שלחתי בטעות",
  ].join("\n");

  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "unsolicited_document" satisfies PendingConfirmationKind,
    payload: { documentId: params.documentId, documentType: params.documentType },
    question,
    reminderIntervalDays,
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
}): Promise<void> {
  const { reminderIntervalDays } = await getConfirmationReminderConfig(params.organizationId);
  const question = "לא הצלחנו לזהות בוודאות את המסמך ששלחת. אנא כתוב איזה מסמך זה או שלח צילום ברור יותר.";

  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "document_clarification" satisfies PendingConfirmationKind,
    payload: { documentId: params.documentId },
    question,
    reminderIntervalDays,
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
  const payload = resolved.payload as { documentId?: string; documentType?: string } | null;
  const documentId = payload?.documentId;
  if (!documentId) return;
  const documentType = payload?.documentType ?? "מסמך נוסף";

  const db = await getDb();

  if (resolved.status === "declined") {
    // Sent by mistake: never uploaded, never counted, temp bytes cleared
    // per retention policy — nothing left behind.
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
    return;
  }

  if (resolved.status !== "confirmed") return;

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

  await sendOutboundMessage(
    resolved.organizationId,
    resolved.conversationId,
    `תודה, שמרנו את המסמך "${documentType}" בתיקייה שלך.`,
    "ai"
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

    await sendOutboundMessage(
      resolved.organizationId,
      resolved.conversationId,
      `תודה על ההבהרה! שמרנו את המסמך כ"${matchedRequirement.name}".`,
      "ai"
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
    if (row.remindersSent >= maxReminders) {
      const payload = row.payload as { documentId?: string } | null;
      if (payload?.documentId) {
        await db
          .update(documents)
          .set({ status: "needs_review", updatedAt: new Date() })
          .where(eq(documents.id, payload.documentId));
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

    const { sent } = await sendOutboundMessage(organizationId, row.conversationId, `תזכורת: ${row.question}`, "ai");
    if (sent) {
      await db
        .update(pendingConfirmations)
        .set({
          remindersSent: row.remindersSent + 1,
          nextReminderAt: new Date(Date.now() + reminderIntervalDays * 24 * 60 * 60 * 1000),
        })
        .where(eq(pendingConfirmations.id, row.id));
      reminded += 1;
    }
  }

  return { reminded, escalated };
}
