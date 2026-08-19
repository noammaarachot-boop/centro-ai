import { PDFDocument } from "pdf-lib";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { getValidAccessToken } from "@/lib/googleAuth/driveTokens";
import { downloadDriveFile, updateDriveFileContent, uploadDriveFile } from "@/lib/googleAuth/drive";
import { ensureCollectionRequestDriveFolder } from "@/lib/storage/driveAdapter";
import { resolveDocumentDisplayLabel } from "@/lib/documents/displayLabel";

/**
 * Real single-PDF merging — once multi-signal detection
 * (src/lib/documentContinuation.ts) confidently recognizes that several
 * images are pages of the same document, this is what actually produces
 * ONE real PDF file in Drive as "the active document," rather than leaving
 * several separate image files that merely happen to be linked in the
 * database. Every raw source page still keeps its own individual Drive
 * file too (see documents.mergedPdfDriveFileId's own schema doc comment) —
 * nothing is ever deleted, only combined into an additional, clearly-named
 * merged file.
 *
 * Never destructive on failure: any error (a download failing, an
 * unsupported image format, no Drive connection) is caught, audited, and
 * leaves every existing file exactly as it was — a merge failure just means
 * the request temporarily stays in its pre-merge state (several individual
 * page files, still fully valid and countable), never a lost or corrupted
 * document.
 */

async function embedPage(target: PDFDocument, bytes: Buffer, mimeType: string): Promise<void> {
  if (mimeType === "application/pdf") {
    const source = await PDFDocument.load(bytes);
    const copiedPages = await target.copyPages(source, source.getPageIndices());
    for (const page of copiedPages) target.addPage(page);
    return;
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    const image = await target.embedJpg(bytes);
    const page = target.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return;
  }
  if (mimeType === "image/png") {
    const image = await target.embedPng(bytes);
    const page = target.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return;
  }
  throw new Error(`Unsupported mime type for PDF merging: ${mimeType}`);
}

// Pure (given already-downloaded bytes) — pages are embedded in the exact
// order given, never reordered here; the caller is responsible for
// resolving the correct page order (receivedAt, the same order pages
// naturally arrive in a burst).
export async function mergePagesToPdf(pages: Array<{ bytes: Buffer; mimeType: string }>): Promise<Buffer> {
  const target = await PDFDocument.create();
  for (const page of pages) {
    await embedPage(target, page.bytes, page.mimeType);
  }
  const bytes = await target.save();
  return Buffer.from(bytes);
}

function buildMergedFileName(headFileName: string): string {
  const dotIndex = headFileName.lastIndexOf(".");
  const base = dotIndex >= 0 ? headFileName.slice(0, dotIndex) : headFileName;
  return `${base} (מאוחד).pdf`;
}

// Called after a continuation page is confidently detected and uploaded to
// Drive (conversationActions.ts) — downloads every page in the group (the
// head document plus every page pointing continuationOfDocumentId at it),
// merges them into one real PDF, and either creates the group's merged
// file for the first time or updates it in place (same Drive file id — "no
// duplication") when a later page extends an already-merged group,
// incrementing mergedPdfVersion as its own lightweight version history.
export async function mergeContinuationGroupToPdf(
  organizationId: string,
  collectionRequestId: string,
  headDocumentId: string
): Promise<void> {
  const db = await getDb();
  const [head] = await db.select().from(documents).where(eq(documents.id, headDocumentId)).limit(1);
  if (!head || !head.googleDriveFileId) return;

  const continuationPages = await db
    .select()
    .from(documents)
    .where(and(eq(documents.continuationOfDocumentId, headDocumentId)))
    .orderBy(asc(documents.receivedAt));
  const uploadedContinuations = continuationPages.filter((doc) => doc.googleDriveFileId);
  if (uploadedContinuations.length === 0) return;

  const allPageDocs = [head, ...uploadedContinuations];
  const headLabel = resolveDocumentDisplayLabel(head.displayLabel);

  try {
    const accessToken = await getValidAccessToken(organizationId);
    const downloaded: Array<{ bytes: Buffer; mimeType: string }> = [];
    for (const doc of allPageDocs) {
      downloaded.push(await downloadDriveFile(accessToken, doc.googleDriveFileId!));
    }
    const mergedBytes = await mergePagesToPdf(downloaded);

    if (head.mergedPdfDriveFileId) {
      await updateDriveFileContent(accessToken, head.mergedPdfDriveFileId, mergedBytes, "application/pdf");
      const newVersion = (head.mergedPdfVersion ?? 1) + 1;
      await db
        .update(documents)
        .set({ mergedPdfVersion: newVersion, updatedAt: new Date() })
        .where(eq(documents.id, headDocumentId));
      await recordAuditEvent({
        organizationId,
        eventType: "document.merged_pdf_updated",
        description: `קובץ ה-PDF המאוחד עבור "${headLabel}" עודכן לגרסה ${newVersion} (${allPageDocs.length} עמודים) לאחר קבלת עמוד נוסף`,
        actorType: "system",
        collectionRequestId,
        metadata: { documentId: headDocumentId, driveFileId: head.mergedPdfDriveFileId, version: newVersion, pageCount: allPageDocs.length },
      });
    } else {
      const { folderId } = await ensureCollectionRequestDriveFolder(collectionRequestId);
      const uploaded = await uploadDriveFile(accessToken, {
        name: buildMergedFileName(head.fileName),
        parentId: folderId,
        mimeType: "application/pdf",
        content: mergedBytes,
      });
      await db
        .update(documents)
        .set({ mergedPdfDriveFileId: uploaded.id, mergedPdfVersion: 1, updatedAt: new Date() })
        .where(eq(documents.id, headDocumentId));
      await recordAuditEvent({
        organizationId,
        eventType: "document.merged_pdf_created",
        description: `נוצר קובץ PDF מאוחד אחד עבור "${headLabel}" (${allPageDocs.length} עמודים)`,
        actorType: "system",
        collectionRequestId,
        metadata: { documentId: headDocumentId, driveFileId: uploaded.id, pageCount: allPageDocs.length },
      });
    }
  } catch (error) {
    console.error("[document-merge] merge failed (non-fatal — every individual page file remains intact)", error);
    await recordAuditEvent({
      organizationId,
      eventType: "document.merge_failed",
      description: `איחוד עמודי המסמך "${headLabel}" לקובץ PDF אחד נכשל — כל הקבצים המקוריים עדיין שמורים ב-Drive`,
      actorType: "system",
      collectionRequestId,
      metadata: { documentId: headDocumentId },
    });
  }
}
