import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequestRequirements, collectionRequests, documents, organizations } from "@/db/schema";
import { OperationFailedError, withRetry } from "@/lib/resilience";
import { getValidAccessToken, GoogleNotConnectedError } from "@/lib/googleAuth/driveTokens";
import {
  createDriveFolder,
  DriveApiError,
  findFolderByClientProperty,
  findFoldersByName,
  listFolderFiles,
  moveDriveFile,
  setFolderClientProperty,
  trashDriveFolder,
  uploadDriveFile,
  type DriveFolderRef,
} from "@/lib/googleAuth/drive";
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

// A same-named folder already sitting in the parent (found once the caller
// has already ruled out — via findFolderByClientProperty — that it's
// tagged as *this* client's) is only safe to reuse bare-named when nothing
// else could be claiming that exact name. Once the one-off backfill
// (scripts/backfillClientDriveFolderTags.ts) has tagged every pre-existing
// client folder, any untagged-or-differently-tagged same-named folder found
// here is a genuine collision with a different client, not a legacy folder
// of this one — so the safe default is always a suffix, never a guess.
// The suffix is an opaque slice of the client's own internal id — never a
// government id number or other sensitive personal data (per product
// requirement: no ID-card numbers or similar in a folder name).
async function resolveClientFolderName(
  accessToken: string,
  parentId: string,
  clientName: string,
  clientId: string
): Promise<string> {
  const existing = await findFoldersByName(accessToken, parentId, clientName);
  if (existing.length === 0) return clientName;
  return `${clientName} - ${clientId.slice(-5)}`;
}

// BR-3.003: store the folder ID, not its name. One folder per client,
// created lazily on first use rather than during onboarding/import, nested
// inside the organization's own selected root folder. Throws
// GoogleNotConnectedError if the organization hasn't completed OAuth +
// folder selection yet — callers (uploadDocument below, and its own
// resilient wrappers) must not let that crash a Collection Request.
//
// Race safety: two documents for the same client can arrive within
// seconds of each other (e.g. two WhatsApp attachments), and Vercel's
// serverless model gives each webhook call its own process — there is no
// in-memory lock to share between them. A Postgres advisory lock, keyed by
// (organization's parent folder, normalized client name) rather than just
// this client id, serializes the search-then-create sequence below across
// both the common case (the same client's two attachments) and the rarer
// case of two different clients who happen to share a display name and
// both get their first-ever document at nearly the same instant. The lock
// is scoped to this transaction and releases automatically on
// commit/rollback — nothing to clean up explicitly.
export async function ensureClientFolder(clientId: string): Promise<DriveFolder> {
  const db = await getDb();

  const [client] = await db
    .select({ driveFolderId: clients.driveFolderId, name: clients.name, organizationId: clients.organizationId })
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
  const parentId = organization.googleDriveFolderId;
  const accessToken = await getValidAccessToken(client.organizationId);

  return db.transaction(async (tx) => {
    const lockKey = `${parentId}::${client.name.trim().toLowerCase()}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // Re-check under the lock — another request for this same client may
    // have already resolved and committed a folder while this one waited.
    const [freshClient] = await tx
      .select({ driveFolderId: clients.driveFolderId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (freshClient?.driveFolderId) {
      return { folderId: freshClient.driveFolderId };
    }

    // Already exists, tagged as this exact client's — adopt it. Covers a
    // prior run that created the Drive folder but crashed before the DB
    // write landed, and legacy folders the one-off backfill has tagged.
    const tagged = await findFolderByClientProperty(accessToken, parentId, clientId);
    if (tagged) {
      await tx.update(clients).set({ driveFolderId: tagged.id, updatedAt: new Date() }).where(eq(clients.id, clientId));
      return { folderId: tagged.id };
    }

    const folderName = await resolveClientFolderName(accessToken, parentId, client.name, clientId);
    const folder = await createDriveFolder(accessToken, folderName, parentId, { centroClientId: clientId });
    await tx.update(clients).set({ driveFolderId: folder.id, updatedAt: new Date() }).where(eq(clients.id, clientId));
    return { folderId: folder.id };
  });
}

// Locates every Drive folder that could plausibly be a leftover duplicate
// for this client under the org's parent folder (by exact name, by the
// collision-suffixed name, and by the client-id property tag — a duplicate
// created by an earlier, race-prone version of ensureClientFolder could
// match any of the three depending on when it was created), merges every
// file from every duplicate into one surviving primary folder, verifies
// each move before trashing the now-empty duplicate, and points
// clients.driveFolderId at the primary. Idempotent — safe to run again
// (finds nothing to merge once no duplicates remain) and safe to run for a
// client that never had a duplicate in the first place.
export async function mergeDuplicateClientFolders(
  clientId: string
): Promise<{ primaryFolderId: string; duplicatesMerged: number; filesMoved: number }> {
  const db = await getDb();
  const [client] = await db
    .select({ driveFolderId: clients.driveFolderId, name: clients.name, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const [organization] = await db
    .select({ googleDriveFolderId: organizations.googleDriveFolderId })
    .from(organizations)
    .where(eq(organizations.id, client.organizationId))
    .limit(1);
  if (!organization?.googleDriveFolderId) {
    throw new GoogleNotConnectedError();
  }
  const parentId = organization.googleDriveFolderId;
  const accessToken = await getValidAccessToken(client.organizationId);

  const byName = await findFoldersByName(accessToken, parentId, client.name);
  const bySuffixedName = await findFoldersByName(accessToken, parentId, `${client.name} - ${clientId.slice(-5)}`);
  const byTag = await findFolderByClientProperty(accessToken, parentId, clientId);

  const seen = new Map<string, DriveFolderRef>();
  for (const folder of [...byName, ...bySuffixedName, ...(byTag ? [byTag] : [])]) {
    seen.set(folder.id, folder);
  }
  const all = [...seen.values()];

  if (all.length === 0) {
    return { primaryFolderId: client.driveFolderId ?? "", duplicatesMerged: 0, filesMoved: 0 };
  }

  const primaryId =
    client.driveFolderId && all.some((f) => f.id === client.driveFolderId) ? client.driveFolderId : all[0].id;
  const duplicates = all.filter((f) => f.id !== primaryId);

  let filesMoved = 0;
  for (const duplicate of duplicates) {
    const files = await listFolderFiles(accessToken, duplicate.id);
    for (const file of files) {
      await moveDriveFile(accessToken, file.id, duplicate.id, primaryId);
      filesMoved += 1;
    }
    // Verify before trashing — never discard a folder that still holds a
    // file the move silently failed to relocate.
    const remaining = await listFolderFiles(accessToken, duplicate.id);
    if (remaining.length > 0) {
      throw new DriveApiError(
        `Refusing to trash Drive folder ${duplicate.id}: ${remaining.length} file(s) failed to move to ${primaryId}`
      );
    }
    await trashDriveFolder(accessToken, duplicate.id);
  }

  await setFolderClientProperty(accessToken, primaryId, clientId);
  await db.update(clients).set({ driveFolderId: primaryId, updatedAt: new Date() }).where(eq(clients.id, clientId));

  return { primaryFolderId: primaryId, duplicatesMerged: duplicates.length, filesMoved };
}

function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
}

// Anti-overwrite: Drive itself never overwrites on a name collision (two
// files can share a name with no error), but that just leaves confusing
// duplicate-named files sitting in the client's folder — e.g. a client
// re-sending "תעודת זהות" a second time. Appends " (2)", " (3)", ... the
// same way a desktop file manager would, checked against what's actually
// in the folder right now rather than trusting any cache.
async function resolveUniqueDriveFileName(accessToken: string, folderId: string, desiredName: string): Promise<string> {
  const existingNames = new Set((await listFolderFiles(accessToken, folderId)).map((f) => f.name));
  if (!existingNames.has(desiredName)) return desiredName;

  const ext = fileExtension(desiredName);
  const base = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let attempt = 2;
  while (existingNames.has(`${base} (${attempt})${ext}`)) {
    attempt += 1;
  }
  return `${base} (${attempt})${ext}`;
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
    .select({ fileName: documents.fileName, requirementId: documents.requirementId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!document) throw new Error(`Document ${documentId} not found`);

  // Prefer the matched requirement's own name over the stored fileName —
  // for a real WhatsApp attachment that's a meaningless generated name
  // (image_<wamid>.jpg; see resolveAttachment in the webhook route), never
  // what a client or employee would recognize in Drive. Falls back to the
  // stored fileName when there's no requirement match (needs_review
  // documents never reach here — see the `status === "approved"` gate in
  // processInboundAttachment/reviewDocument) or it's a manual upload that
  // already had a real name.
  let targetFileName = document.fileName;
  if (document.requirementId) {
    const [requirement] = await db
      .select({ name: collectionRequestRequirements.name })
      .from(collectionRequestRequirements)
      .where(eq(collectionRequestRequirements.id, document.requirementId))
      .limit(1);
    if (requirement) {
      targetFileName = `${requirement.name}${fileExtension(document.fileName)}`;
    }
  }

  return withRetry(async () => {
    const accessToken = await getValidAccessToken(client.organizationId);
    const content = fileBytes ?? placeholderContent(document.fileName);
    const contentType = fileBytes ? mimeType ?? "application/octet-stream" : "text/plain; charset=utf-8";
    const uniqueFileName = await resolveUniqueDriveFileName(accessToken, folderId, targetFileName);

    const uploaded = await uploadDriveFile(accessToken, {
      name: uniqueFileName,
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
