import { withRetry } from "@/lib/resilience";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// Static is fine — this only needs to not collide with the multipart
// body's own content, never to be secret or unique per request.
const UPLOAD_BOUNDARY = "centro-drive-upload-boundary";

export interface DriveFolderRef {
  id: string;
  name: string;
}

export interface DriveFileRef {
  id: string;
  name: string;
  webViewLink: string | null;
}

export class DriveApiError extends Error {}

async function driveFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  return withRetry(() =>
    fetch(`${DRIVE_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    })
  );
}

// Creating a folder is always allowed under the minimal drive.file scope
// (the app owns anything it creates) — no Picker interaction needed.
// `parentId` nests it inside another folder Centro already owns/was
// granted (the organization's own selected root folder, or another
// folder Centro itself created) — omit it only for the root
// folder-creation flow during onboarding, which has no parent yet.
export async function createDriveFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<DriveFolderRef> {
  const response = await driveFetch(accessToken, "/files?fields=id,name", {
    method: "POST",
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: parentId ? [parentId] : undefined,
    }),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to create Drive folder (${response.status})`);
  }
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

// Simple (non-resumable) multipart upload — appropriate for the small
// document files this app handles; Google recommends resumable upload
// only above ~5MB. Hand-built multipart/related body (two parts: JSON
// metadata, then raw content) rather than pulling in a form-data
// dependency for one call site.
export async function uploadDriveFile(
  accessToken: string,
  options: { name: string; parentId: string; mimeType: string; content: Buffer }
): Promise<DriveFileRef> {
  const metadata = JSON.stringify({ name: options.name, parents: [options.parentId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${UPLOAD_BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      "utf-8"
    ),
    Buffer.from(`--${UPLOAD_BOUNDARY}\r\nContent-Type: ${options.mimeType}\r\n\r\n`, "utf-8"),
    options.content,
    Buffer.from(`\r\n--${UPLOAD_BOUNDARY}--`, "utf-8"),
  ]);

  const response = await withRetry(() =>
    fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,webViewLink`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${UPLOAD_BOUNDARY}`,
      },
      body,
    })
  );
  if (!response.ok) {
    throw new DriveApiError(`Failed to upload file to Drive (${response.status})`);
  }
  const data = (await response.json()) as { id: string; name: string; webViewLink?: string };
  return { id: data.id, name: data.name, webViewLink: data.webViewLink ?? null };
}

// Reads back a file Centro itself just uploaded — used to verify the
// upload actually landed in Drive rather than trusting the create
// response alone.
export async function getDriveFile(accessToken: string, fileId: string): Promise<DriveFileRef> {
  const response = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?fields=id,name,webViewLink,trashed`
  );
  if (!response.ok) {
    throw new DriveApiError(`Drive file not accessible (${response.status})`);
  }
  const data = (await response.json()) as {
    id: string;
    name: string;
    webViewLink?: string;
    trashed: boolean;
  };
  if (data.trashed) {
    throw new DriveApiError("File was deleted from Drive.");
  }
  return { id: data.id, name: data.name, webViewLink: data.webViewLink ?? null };
}

// Validates a folder the client claims the user selected via Picker —
// never trust the folder id/name a client sends without confirming with
// Google that it's (a) actually reachable under this token and (b)
// actually a folder, not some other file type.
export async function getDriveFolder(accessToken: string, folderId: string): Promise<DriveFolderRef> {
  const response = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`
  );
  if (!response.ok) {
    throw new DriveApiError(`Drive folder not accessible (${response.status})`);
  }
  const data = (await response.json()) as {
    id: string;
    name: string;
    mimeType: string;
    trashed: boolean;
  };
  if (data.mimeType !== FOLDER_MIME_TYPE || data.trashed) {
    throw new DriveApiError("Selected item is not an active Drive folder.");
  }
  return { id: data.id, name: data.name };
}
