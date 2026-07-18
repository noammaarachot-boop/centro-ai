import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, documents } from "@/db/schema";

/**
 * Google Drive is mocked throughout this module — no real OAuth/API calls
 * exist yet (that requires a Google Cloud project and credentials this
 * pilot doesn't have set up). `ensureClientFolder` and `uploadDocument`
 * are the two functions a real implementation replaces; every caller
 * (document approval, the UI's "open in Drive" link) only ever deals with
 * the folder/file ID they return, so swapping the mock for the real
 * Google Drive API later is a change inside this file only.
 *
 * PR-005 / DB-8.3: Drive stores the file, Centro stores metadata + the
 * reference — reflected here by generating an ID and link, never any
 * actual file bytes.
 */

export interface DriveFolder {
  folderId: string;
}

export interface DriveFile {
  fileId: string;
  webViewLink: string;
}

function mockFolderId() {
  return `mock-folder-${randomUUID()}`;
}

function mockFileId() {
  return `mock-file-${randomUUID()}`;
}

export function driveFileLink(fileId: string) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

// BR-3.003: store the folder ID, not its name. One folder per client,
// created lazily on first use rather than during onboarding/import.
export async function ensureClientFolder(clientId: string): Promise<DriveFolder> {
  const db = await getDb();
  const [client] = await db
    .select({ driveFolderId: clients.driveFolderId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (client?.driveFolderId) {
    return { folderId: client.driveFolderId };
  }

  const folderId = mockFolderId();
  await db
    .update(clients)
    .set({ driveFolderId: folderId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  return { folderId };
}

// BR-11.5: only validated (approved) documents are stored in Drive.
// Callers are expected to have already set the document's status to
// "approved" before calling this.
export async function uploadDocument(
  clientId: string,
  documentId: string
): Promise<DriveFile> {
  await ensureClientFolder(clientId);
  const fileId = mockFileId();

  const db = await getDb();
  await db
    .update(documents)
    .set({ googleDriveFileId: fileId, updatedAt: new Date() })
    .where(eq(documents.id, documentId));

  return { fileId, webViewLink: driveFileLink(fileId) };
}
