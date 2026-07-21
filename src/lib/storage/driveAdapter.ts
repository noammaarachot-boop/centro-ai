import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, documents, organizations } from "@/db/schema";
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
 * `uploadDocument`'s actual file *content* is still a placeholder when no
 * real bytes are supplied (see PLACEHOLDER_CONTENT below) — this product
 * has no real inbound-document channel yet (WhatsApp receipt is still
 * mocked, see src/lib/conversationOrchestration.ts), so there is nothing
 * real to upload from that path. The one place real bytes genuinely exist
 * today is a manual document upload by an employee (addManualDocument,
 * src/app/(app)/collections/actions.ts), which passes them through here
 * unchanged. Every other call site (WhatsApp-simulated receipt) uploads an
 * honest, clearly-labeled placeholder instead of pretending to have real
 * content — the Drive folder/upload mechanics themselves are 100% real
 * either way, only the file's content differs.
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

// FR-15.3: employees are notified only when automation genuinely can't
// recover — withRetry already exhausted retries before OperationFailedError
// is ever reached. BR-15.1: a Drive failure is logged and the document
// stays approved-but-unfiled; it must never crash the caller or leave the
// Collection Request in a broken state. Shared by every call site that
// uploads a just-approved document (manual add, review, and AI
// auto-approval via the WhatsApp simulator) so all three degrade the same
// way — a document approved before the organization ever connects Drive
// gets its own clear, distinct audit message rather than being reported
// as a generic upload failure.
export async function uploadDocumentResiliently(
  organizationId: string,
  clientId: string,
  documentId: string,
  fileName: string,
  collectionRequestId: string,
  fileBytes?: Buffer,
  mimeType?: string
): Promise<void> {
  try {
    await uploadDocument(clientId, documentId, fileBytes, mimeType);
  } catch (error) {
    if (error instanceof GoogleNotConnectedError) {
      await recordAuditEvent({
        organizationId,
        eventType: "document.drive_upload_skipped",
        description: `המסמך "${fileName}" אושר אך לא הועלה ל-Drive — חשבון Google עדיין לא מחובר לתיקייה`,
        actorType: "system",
        clientId,
        collectionRequestId,
      });
      return;
    }
    if (!(error instanceof OperationFailedError)) throw error;
    await recordAuditEvent({
      organizationId,
      eventType: "document.drive_upload_failed",
      description: `העלאת "${fileName}" ל-Drive נכשלה לאחר ניסיונות חוזרים - דורש בדיקת עובד`,
      actorType: "system",
      clientId,
      collectionRequestId,
    });
  }
}
