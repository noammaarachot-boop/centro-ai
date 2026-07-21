import { withRetry } from "@/lib/resilience";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export interface DriveFolderRef {
  id: string;
  name: string;
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
export async function createDriveFolder(accessToken: string, name: string): Promise<DriveFolderRef> {
  const response = await driveFetch(accessToken, "/files?fields=id,name", {
    method: "POST",
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE }),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to create Drive folder (${response.status})`);
  }
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
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
