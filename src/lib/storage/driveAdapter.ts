import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, documents, organizations } from "@/db/schema";
import { OperationFailedError, withRetry } from "@/lib/resilience";
import { getValidAccessToken, GoogleNotConnectedError } from "@/lib/googleAuth/driveTokens";
import { createDriveFolder, uploadDriveFile } from "@/lib/googleAuth/drive";
import { recordAuditEvent } from "@/lib/audit";

/**
 * Real Google Drive integration (Google Drive OAuth Integration round —
 * see ARCHITECTURE.md's Document History). Every write happens inside the
 * organization's own selected root folder (organizations.googleDriveFolderId,
 * chosen via OAuth + Picker/create-folder in onboarding), one subfolder per
 * client — Centro never has access to, or writes outside of, that one
 * folder, matching the drive.file scope's own promise.
 *
 * `uploadDocument`'s actual file *content* falls back to a placeholder
 * only when no real bytes are supplied (see placeholderContent below) —
 * e.g. simulateInboundMessage's UI-driven filename-only stand-in, which
 * has no bytes to give it. Real inbound WhatsApp attachments (M-WA-4, see
 * src/lib/whatsapp/media.ts and the webhook route) and manual uploads
 * (addManualDocument, src/app/(app)/collections/actions.ts) both pass
 * their real bytes through here unchanged.
 */

export interface DriveFolder {
  folderId: string;
}

export interface DriveFile {
  fileId: string;
  webViewLink: string;
}

export function driveFileLink(fileId: string) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function placeholderContent(fileName: string): Buffer {
  return Buffer.from(
    [
      "מסמך ממלא-מקום מאת Centro",
      "",
      `שם המסמך: ${fileName}`,
      "",
      "תוכן הקובץ המקורי אינו זמין — ערוץ הקבלה (וואטסאפ) עדיין מדומה בסביבה זו,",
      "ואין מקור אמיתי לבייטים של הקובץ. מנגנון האחסון ב-Drive עצמו הוא אמיתי:",
      "תיקייה זו והקובץ בתוכה נוצרו בפועל דרך Google Drive API.",
    ].join("\n"),
    "utf-8"
  );
}

// BR-3.003: store the folder ID, not its name. One folder per client,
// created lazily on first use rather than during onboarding/import,
// nested inside the organization's own selected root folder. Throws
// GoogleNotConnectedError if the organization hasn't completed OAuth +
// folder selection yet — callers (uploadDocument below, and its own
// resilient wrappers) must not let that crash a Collection Request.
export async function ensureClientFolder(clientId: string): Promise<DriveFolder> {
  const db = await getDb();
  const [client] = await db
    .select({
      driveFolderId: clients.driveFolderId,
      name: clients.name,
      organizationId: clients.organizationId,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  if (client.driveFolderId) {
    return { folderId: client.driveFolderId };
  }

  const [organization] = await db
    .select({ googleDriveFolderId: organizations.googleDriveFolderId })
    .from(organizations)
    .where(eq(organizations.id, client.organizationId))
    .limit(1);
  if (!organization?.googleDriveFolderId) {
    throw new GoogleNotConnectedError();
  }

  const accessToken = await getValidAccessToken(client.organizationId);
  const folder = await createDriveFolder(accessToken, client.name, organization.googleDriveFolderId);

  await db
    .update(clients)
    .set({ driveFolderId: folder.id, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  return { folderId: folder.id };
}

// BR-11.5: only validated (approved) documents are stored in Drive.
// Callers are expected to have already set the document's status to
// "approved" before calling this. `fileBytes`/`mimeType` are optional —
// when a real file was attached (manual upload), its real bytes are
// uploaded as-is; otherwise an honest placeholder is uploaded instead
// (see module doc comment above). The actual upload call is wrapped in
// withRetry (FR-15.2) — callers must catch OperationFailedError/
// GoogleNotConnectedError and degrade gracefully (BR-15.1: a storage
// failure must never corrupt or close a Collection Request) rather than
// letting it crash the action.
export async function uploadDocument(
  clientId: string,
  documentId: string,
  fileBytes?: Buffer,
  mimeType?: string
): Promise<DriveFile> {
  const { folderId } = await ensureClientFolder(clientId);

  const db = await getDb();
  const [client] = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const [document] = await db
    .select({ fileName: documents.fileName })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!document) throw new Error(`Document ${documentId} not found`);

  return withRetry(async () => {
    const accessToken = await getValidAccessToken(client.organizationId);
    const content = fileBytes ?? placeholderContent(document.fileName);
    const contentType = fileBytes ? mimeType ?? "application/octet-stream" : "text/plain; charset=utf-8";

    const uploaded = await uploadDriveFile(accessToken, {
      name: document.fileName,
      parentId: folderId,
      mimeType: contentType,
      content,
    });

    await db
      .update(documents)
      .set({ googleDriveFileId: uploaded.id, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    return { fileId: uploaded.id, webViewLink: uploaded.webViewLink ?? driveFileLink(uploaded.id) };
  });
}

// Product Evolution M9 ("Never Lose a Document") — retries stop being
// attempted, and the document is surfaced as needing real human attention,
// once it's failed this many times. Chosen to give a genuinely transient
// outage (a few hours, even a full day of Google downtime) plenty of room
// across the existing cron cadence, without retrying an unrecoverable
// failure (e.g. a permanently revoked grant) forever.
export const DRIVE_RETRY_MAX_ATTEMPTS = 8;

// FR-15.3: employees are notified only when automation genuinely can't
// recover — withRetry already exhausted retries before OperationFailedError
// is ever reached. BR-15.1: a Drive failure is logged and the document
// stays approved-but-unfiled; it must never crash the caller or leave the
// Collection Request in a broken state. Shared by every call site that
// uploads a just-approved document (manual add, review, and real inbound
// WhatsApp attachments) so all three degrade the same way — a document
// approved before the organization ever connects Drive gets its own clear,
// distinct audit message rather than being reported as a generic upload
// failure.
//
// "Never lose a document": the caller is responsible for having already
// persisted `fileBytes` into documents.pendingFileContent *before* calling
// this (see collections/actions.ts's reviewDocument and
// conversationActions.ts's processInboundAttachment) — this function only
// ever clears that column once the upload has genuinely succeeded, and on
// failure records driveUploadFailedAt/driveUploadRetryCount so
// src/lib/scheduler.ts's cron tick can retry it later without any bytes
// having to survive anywhere else in the meantime.
export async function uploadDocumentResiliently(
  organizationId: string,
  clientId: string,
  documentId: string,
  fileName: string,
  collectionRequestId: string,
  fileBytes?: Buffer,
  mimeType?: string
): Promise<{ uploaded: boolean }> {
  console.log("[wa-inbound] uploadDocumentResiliently START", { documentId, collectionRequestId, fileName });
  const db = await getDb();
  try {
    const uploaded = await uploadDocument(clientId, documentId, fileBytes, mimeType);
    console.log("[wa-inbound] uploadDocumentResiliently OK", { documentId, driveFileId: uploaded.fileId });
    // Success — the real bytes are safely in Drive now; the temporary copy
    // (if any was held) and the retry-tracking columns are no longer
    // needed.
    await db
      .update(documents)
      .set({
        pendingFileContent: null,
        pendingFileMimeType: null,
        driveUploadFailedAt: null,
        driveUploadRetryCount: 0,
        driveRetryExhaustedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));
    return { uploaded: true };
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      console.error("[wa-inbound] uploadDocumentResiliently SKIPPED: Google not connected", { documentId });
      await db
        .update(documents)
        .set({ driveUploadFailedAt: new Date(), updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await recordAuditEvent({
        organizationId,
        eventType: "document.drive_upload_skipped",
        description: `המסמך "${fileName}" אושר אך לא הועלה ל-Drive — חשבון Google עדיין לא מחובר לתיקייה. המסמך נשמר באופן זמני ויועלה אוטומטית ברגע שהחיבור יחודש.`,
        actorType: "system",
        clientId,
        collectionRequestId,
      });
      return { uploaded: false };
    }
    if (!(error instanceof OperationFailedError)) throw error;
    console.error("[wa-inbound] uploadDocumentResiliently FAILED (will retry)", { documentId, error });

    const [current] = await db
      .select({ driveUploadRetryCount: documents.driveUploadRetryCount })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const retryCount = (current?.driveUploadRetryCount ?? 0) + 1;
    const exhausted = retryCount >= DRIVE_RETRY_MAX_ATTEMPTS;

    await db
      .update(documents)
      .set({
        driveUploadFailedAt: new Date(),
        driveUploadRetryCount: retryCount,
        ...(exhausted ? { driveRetryExhaustedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    await recordAuditEvent({
      organizationId,
      eventType: exhausted ? "document.drive_upload_exhausted" : "document.drive_upload_failed",
      description: exhausted
        ? `העלאת "${fileName}" ל-Drive נכשלה ${retryCount} פעמים ברציפות — נדרשת בדיקה ידנית דחופה. המסמך עדיין נשמר באופן זמני ולא אבד.`
        : `העלאת "${fileName}" ל-Drive נכשלה (ניסיון ${retryCount}/${DRIVE_RETRY_MAX_ATTEMPTS}) — תתבצע אוטומטית התנסות חוזרת. המסמך נשמר באופן זמני ולא אבד.`,
      actorType: "system",
      clientId,
      collectionRequestId,
      metadata: { severity: exhausted ? "critical" : "warning", retryCount },
    });
    return { uploaded: false };
  }
}

// Product Evolution M9 — the retry pass itself, called from
// src/lib/scheduler.ts's cron tick. Finds every document still holding a
// safe temporary copy after a failed upload (driveUploadFailedAt set,
// pendingFileContent still present, not yet exhausted) and attempts it
// again through the exact same resilient path — never a separate,
// divergent upload code path.
export async function retryFailedDriveUploads(organizationId: string): Promise<{ retried: number }> {
  const db = await getDb();
  const pending = await db
    .select({
      id: documents.id,
      collectionRequestId: documents.collectionRequestId,
      fileName: documents.fileName,
      pendingFileContent: documents.pendingFileContent,
      pendingFileMimeType: documents.pendingFileMimeType,
    })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        isNotNull(documents.driveUploadFailedAt),
        isNull(documents.driveRetryExhaustedAt)
      )
    );

  let retried = 0;
  for (const doc of pending) {
    const [request] = await db
      .select({ clientId: collectionRequests.clientId })
      .from(collectionRequests)
      .where(eq(collectionRequests.id, doc.collectionRequestId))
      .limit(1);
    if (!request) continue;

    await uploadDocumentResiliently(
      organizationId,
      request.clientId,
      doc.id,
      doc.fileName,
      doc.collectionRequestId,
      doc.pendingFileContent ?? undefined,
      doc.pendingFileMimeType ?? undefined
    );
    retried += 1;
  }

  return { retried };
}
