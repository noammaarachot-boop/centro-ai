import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { classifyDocumentRelationIntent } from "@/lib/ai/conversationReplyIntent";
import { markDocumentSupersededInDrive } from "@/lib/storage/driveAdapter";
import { resolveDocumentDisplayLabel } from "@/lib/documents/displayLabel";

/**
 * Document replace/supersede — "זה מחליף את הקודם" said alongside a new
 * document (as its WhatsApp caption — see the webhook route's own
 * caption-parsing comment) marks the most relevant already-approved
 * document for the same requirement as superseded, never deleted: the row
 * and its real Drive file both stay, renamed to make the supersession
 * visible (markDocumentSupersededInDrive), so nothing is ever silently
 * lost. Only ever acted on once the free-text classifier (classifyDocumentRelationIntent)
 * confidently recognizes a replace statement — never guessed from a caption
 * that doesn't clearly say so.
 *
 * Scope note: when more than one prior approved document exists for the
 * same requirement (a requiredCount > 1 requirement, e.g. "3 payslips"),
 * this defaults to the most recently approved one rather than asking a
 * clarifying question — a deliberate, disclosed scoping simplification for
 * this genuinely rarer case, not a silent guess about *whether* to replace
 * at all (that part is never guessed).
 */
export async function applyDocumentReplaceIntentIfCaptioned(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  requirementId: string;
  newDocumentId: string;
  captionText: string | null;
}): Promise<void> {
  if (!params.captionText) return;

  const relation = await classifyDocumentRelationIntent(params.captionText);
  console.log("[document-replace] caption relation classified", {
    collectionRequestId: params.collectionRequestId,
    relation,
  });
  if (relation !== "replace") return; // "additional" or "none" — the new document just stands on its own, exactly as normal

  const db = await getDb();
  const candidates = await db
    .select({
      id: documents.id,
      fileName: documents.fileName,
      displayLabel: documents.displayLabel,
      googleDriveFileId: documents.googleDriveFileId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.collectionRequestId, params.collectionRequestId),
        eq(documents.requirementId, params.requirementId),
        eq(documents.status, "approved"),
        isNull(documents.continuationOfDocumentId)
      )
    )
    .orderBy(desc(documents.receivedAt));

  const target = candidates.find((c) => c.id !== params.newDocumentId);
  if (!target) {
    console.log("[document-replace] no prior document found to supersede — nothing to do", {
      collectionRequestId: params.collectionRequestId,
      requirementId: params.requirementId,
    });
    return;
  }

  await db
    .update(documents)
    .set({ status: "superseded", supersededByDocumentId: params.newDocumentId, updatedAt: new Date() })
    .where(eq(documents.id, target.id));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "document.superseded",
    description: `הלקוח ציין שהמסמך "${resolveDocumentDisplayLabel(target.displayLabel)}" הוחלף על ידי מסמך חדש`,
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { supersededDocumentId: target.id, newDocumentId: params.newDocumentId },
  });

  if (target.googleDriveFileId) {
    await markDocumentSupersededInDrive(params.organizationId, target.googleDriveFileId, target.fileName);
  }

  console.log("[document-replace] prior document marked superseded", {
    collectionRequestId: params.collectionRequestId,
    supersededDocumentId: target.id,
    newDocumentId: params.newDocumentId,
  });
}
