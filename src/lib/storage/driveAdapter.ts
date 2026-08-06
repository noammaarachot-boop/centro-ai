import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
  renameDriveFile,
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

const HEBREW_MONTHS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

// "<Hebrew month> <year>", e.g. "אוגוסט 2026" — always computed in Israel
// local time (never the server's own timezone, which on Vercel is UTC) so
// a request created near midnight Israel time never lands in the wrong
// month's folder just because UTC hadn't rolled over yet.
export function formatHebrewMonthYear(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    month: "numeric",
    year: "numeric",
  }).formatToParts(date);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const year = parts.find((p) => p.type === "year")?.value;
  return `${HEBREW_MONTHS[month - 1]} ${year}`;
}

// A same-named folder already sitting in the parent (found once the caller
// has already ruled out — via findFolderByClientProperty — that it's
// tagged as *this* client's) is only safe to reuse bare-named when nothing
// else could be claiming that exact name. Any untagged-or-differently-
// tagged same-named folder found here is a genuine collision with a
// different client, not a legacy folder of this one — so the safe default
// is always a suffix, never a guess. The suffix is an opaque slice of the
// client's own internal id — never a government id number or other
// sensitive personal data (per product requirement: no ID-card numbers or
// similar in a folder name).
async function resolveClientFolderName(
  accessToken: string,
  parentId: string,
  clientName: string,
  clientId: string
): Promise<string> {
  const existing = await findFoldersByName(accessToken, parentId, clientName);
  if (existing.length === 0) return clientName;
  return `${clientName} - ${clientId.slice(-5).toUpperCase()}`;
}

// Month folders need no property tagging (unlike client folders) — a month
// name like "אוגוסט 2026" is an unambiguous, deterministic string with no
// legitimate collision to worry about, so find-by-name-or-create is the
// whole story.
async function resolveMonthFolder(accessToken: string, rootFolderId: string, monthName: string): Promise<string> {
  const existing = await findFoldersByName(accessToken, rootFolderId, monthName);
  if (existing[0]) return existing[0].id;
  const folder = await createDriveFolder(accessToken, monthName, rootFolderId);
  return folder.id;
}

async function resolveClientFolderUnderMonth(
  accessToken: string,
  monthFolderId: string,
  clientId: string,
  clientName: string
): Promise<string> {
  const tagged = await findFolderByClientProperty(accessToken, monthFolderId, clientId);
  if (tagged) return tagged.id;
  const folderName = await resolveClientFolderName(accessToken, monthFolderId, clientName, clientId);
  const folder = await createDriveFolder(accessToken, folderName, monthFolderId, { centroClientId: clientId });
  return folder.id;
}

// The single function responsible for the whole Drive path: <org's chosen
// root>/<Hebrew month year>/<client>. Finds-or-creates the month folder,
// then finds-or-creates the client folder inside it, and returns only the
// client folder id — every upload must use exactly that id and nothing
// else (never the root, never the month folder directly).
//
// Race safety: two documents for the same client (or even two different
// clients sharing a display name) can arrive within seconds of each other,
// and Vercel's serverless model gives each webhook call its own process —
// there is no in-memory lock to share between them. Two Postgres advisory
// locks, held for this call's duration and released automatically at
// commit, serialize the search-then-create sequence at each level: one
// keyed by (root, month name) so the month folder is never created twice,
// nested inside one keyed by (month folder, normalized client name) so the
// client folder is never created twice. Both are scoped strictly to their
// own parent — never a global Drive search.
export async function ensureDrivePath(
  rootFolderId: string,
  requestCreatedAt: Date,
  clientId: string,
  clientName: string
): Promise<{ driveClientFolderId: string }> {
  const db = await getDb();
  const [client] = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);
  const accessToken = await getValidAccessToken(client.organizationId);

  const monthName = formatHebrewMonthYear(requestCreatedAt);
  const normalizedClientName = clientName.trim().toLowerCase();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${rootFolderId}::month::${monthName}`}))`);
    const monthFolderId = await resolveMonthFolder(accessToken, rootFolderId, monthName);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${monthFolderId}::client::${normalizedClientName}`}))`);
    const driveClientFolderId = await resolveClientFolderUnderMonth(accessToken, monthFolderId, clientId, clientName);

    return { driveClientFolderId };
  });
}

// Caches ensureDrivePath's result on the Collection Request itself
// (collectionRequests.driveClientFolderId) — the unit every document
// belongs to (documents.collectionRequestId) and the natural place to
// answer "which Drive folder does the 1st, 5th, and 15th document of this
// request use" with a single stored id instead of a fresh Drive search on
// every upload. A collection request never moves between months once
// created, so this value, once resolved, is permanent for that request's
// lifetime — satisfies "the same client folder minutes, hours, or days
// later" without ever re-deriving the path.
export async function ensureCollectionRequestDriveFolder(collectionRequestId: string): Promise<DriveFolder> {
  const db = await getDb();

  const [request] = await db
    .select({
      driveClientFolderId: collectionRequests.driveClientFolderId,
      clientId: collectionRequests.clientId,
      organizationId: collectionRequests.organizationId,
      createdAt: collectionRequests.createdAt,
    })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!request) throw new Error(`Collection request ${collectionRequestId} not found`);
  if (request.driveClientFolderId) {
    return { folderId: request.driveClientFolderId };
  }

  const [organization] = await db
    .select({ googleDriveFolderId: organizations.googleDriveFolderId })
    .from(organizations)
    .where(eq(organizations.id, request.organizationId))
    .limit(1);
  if (!organization?.googleDriveFolderId) {
    throw new GoogleNotConnectedError();
  }

  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, request.clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${request.clientId} not found`);

  // No wrapping transaction here — ensureDrivePath manages its own (it
  // needs to hold two advisory locks across a Drive search-then-create
  // sequence), and Postgres doesn't support nesting a second
  // db.transaction() inside a first over the same connection. Two
  // concurrent calls for the same request that both miss the cache below
  // will therefore both call ensureDrivePath — redundant, but not
  // incorrect: ensureDrivePath's own locking guarantees they resolve to
  // the identical folder id, so both writes below converge on the same
  // value regardless of ordering.
  const { driveClientFolderId } = await ensureDrivePath(
    organization.googleDriveFolderId!,
    request.createdAt,
    request.clientId,
    client.name
  );
  await db
    .update(collectionRequests)
    .set({ driveClientFolderId, updatedAt: new Date() })
    .where(eq(collectionRequests.id, collectionRequestId));
  return { folderId: driveClientFolderId };
}

// One-time migration helper (see scripts/fixClientDriveFolders.ts): a
// client whose only Drive folder still sits directly under the org's root
// (the pre-monthly-structure layout) gets it relocated under the correct
// month folder — computed from the most recent of this client's collection
// requests that hasn't yet resolved its own driveClientFolderId — and that
// request's driveClientFolderId is set to point at the (now relocated)
// folder. A no-op for a client whose folder is already nested under a
// month folder, or who has no legacy flat folder to relocate.
export async function relocateLegacyClientFolder(
  clientId: string
): Promise<{ relocated: boolean; collectionRequestId?: string; monthFolderId?: string; clientFolderId?: string }> {
  const db = await getDb();
  const [client] = await db
    .select({ driveFolderId: clients.driveFolderId, name: clients.name, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.driveFolderId) return { relocated: false };

  const [organization] = await db
    .select({ googleDriveFolderId: organizations.googleDriveFolderId })
    .from(organizations)
    .where(eq(organizations.id, client.organizationId))
    .limit(1);
  if (!organization?.googleDriveFolderId) return { relocated: false };
  const rootFolderId = organization.googleDriveFolderId;
  const accessToken = await getValidAccessToken(client.organizationId);

  // Only a direct child of root is "legacy flat" — already-nested folders
  // (new layout) are left untouched.
  const flatMatches = await findFoldersByName(accessToken, rootFolderId, client.name);
  const isFlatChildOfRoot = flatMatches.some((f) => f.id === client.driveFolderId);
  if (!isFlatChildOfRoot) return { relocated: false };

  const [targetRequest] = await db
    .select({ id: collectionRequests.id, createdAt: collectionRequests.createdAt })
    .from(collectionRequests)
    .where(and(eq(collectionRequests.clientId, clientId), isNull(collectionRequests.driveClientFolderId)))
    .orderBy(desc(collectionRequests.createdAt))
    .limit(1);
  if (!targetRequest) return { relocated: false };

  const monthFolderId = await resolveMonthFolder(
    accessToken,
    rootFolderId,
    formatHebrewMonthYear(targetRequest.createdAt)
  );
  await moveDriveFile(accessToken, client.driveFolderId, rootFolderId, monthFolderId);
  await setFolderClientProperty(accessToken, client.driveFolderId, clientId);
  await db
    .update(collectionRequests)
    .set({ driveClientFolderId: client.driveFolderId, updatedAt: new Date() })
    .where(eq(collectionRequests.id, targetRequest.id));

  return {
    relocated: true,
    collectionRequestId: targetRequest.id,
    monthFolderId,
    clientFolderId: client.driveFolderId,
  };
}

// Locates every Drive folder that could plausibly be a leftover duplicate
// for this client under a given parent folder (by exact name, by the
// collision-suffixed name, and by the client-id property tag — a duplicate
// created by an earlier, race-prone version of the folder resolution logic
// could match any of the three depending on when it was created), merges
// every file from every duplicate into one surviving primary folder,
// verifies each move before trashing the now-empty duplicate, and tags the
// primary. Idempotent — safe to run again (finds nothing once no
// duplicates remain). Takes an explicit parentId (the month folder, or —
// for pre-monthly-structure legacy data — the org root) rather than
// re-deriving it, since which parent to scan depends on which layer of the
// migration is calling it.
export async function mergeDuplicateClientFolders(
  clientId: string,
  parentId: string
): Promise<{ primaryFolderId: string; duplicatesMerged: number; filesMoved: number }> {
  const db = await getDb();
  const [client] = await db
    .select({ name: clients.name, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);
  const accessToken = await getValidAccessToken(client.organizationId);

  const byName = await findFoldersByName(accessToken, parentId, client.name);
  const bySuffixedName = await findFoldersByName(accessToken, parentId, `${client.name} - ${clientId.slice(-5).toUpperCase()}`);
  const byTag = await findFolderByClientProperty(accessToken, parentId, clientId);

  const seen = new Map<string, DriveFolderRef>();
  for (const folder of [...byName, ...bySuffixedName, ...(byTag ? [byTag] : [])]) {
    seen.set(folder.id, folder);
  }
  const all = [...seen.values()];

  if (all.length === 0) {
    return { primaryFolderId: "", duplicatesMerged: 0, filesMoved: 0 };
  }

  const primaryId = byTag?.id ?? all[0].id;
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

  return { primaryFolderId: primaryId, duplicatesMerged: duplicates.length, filesMoved };
}

export function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
}

// Anti-overwrite: Drive itself never overwrites on a name collision (two
// files can share a name with no error), but that just leaves confusing
// duplicate-named files sitting in the client's folder — e.g. a client
// re-sending "תעודת זהות" a second time (an updated copy, not a duplicate
// upload of the identical file — that case is caught earlier, by
// isFuzzyDuplicate in conversationActions.ts, before a Drive upload is
// ever attempted). Appends " - גרסה 2", " - גרסה 3", ..., checked against
// what's actually in the folder right now rather than trusting any cache —
// never silently overwrites a prior version.
async function resolveUniqueDriveFileName(accessToken: string, folderId: string, desiredName: string): Promise<string> {
  const existingNames = new Set((await listFolderFiles(accessToken, folderId)).map((f) => f.name));
  if (!existingNames.has(desiredName)) return desiredName;

  const ext = fileExtension(desiredName);
  const base = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let attempt = 2;
  while (existingNames.has(`${base} - גרסה ${attempt}${ext}`)) {
    attempt += 1;
  }
  return `${base} - גרסה ${attempt}${ext}`;
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
  collectionRequestId: string,
  fileBytes?: Buffer,
  mimeType?: string
): Promise<DriveFile> {
  const { folderId } = await ensureCollectionRequestDriveFolder(collectionRequestId);

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
    const uploaded = await uploadDocument(clientId, documentId, collectionRequestId, fileBytes, mimeType);
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

// Document replace/supersede (src/lib/documentReplace.ts) — "archive/mark,
// never delete without need": a superseded document keeps its real file in
// Drive, just renamed to make its status visible at a glance instead of
// looking like an active, current document. Best-effort and non-throwing —
// same resilience philosophy as uploadDocumentResiliently: a rename
// failure (Drive not connected, a transient API error) must never block
// the replace decision itself, which has already been recorded in the
// database by the time this runs.
export async function markDocumentSupersededInDrive(organizationId: string, driveFileId: string, fileName: string): Promise<void> {
  try {
    const accessToken = await getValidAccessToken(organizationId);
    await withRetry(() => renameDriveFile(accessToken, driveFileId, `[הוחלף] ${fileName}`));
  } catch (error) {
    console.error("[document-replace] renaming superseded file in Drive failed (non-fatal)", error);
  }
}
