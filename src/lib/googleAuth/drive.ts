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

// Escapes a value for safe interpolation into a Drive `q` search string —
// Drive's query grammar treats a bare `'` as the string delimiter itself,
// so any `'` inside a client/file name (e.g. "O'Brien") must be backslash-
// escaped or it would break out of the quoted literal. Never used to build
// SQL — this is Drive API's own query language, unrelated to the app's
// Postgres layer.
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listDriveItems(
  accessToken: string,
  query: string,
  fields: string
): Promise<Array<Record<string, string>>> {
  const params = new URLSearchParams({
    q: query,
    fields: `files(${fields})`,
    pageSize: "100",
    spaces: "drive",
  });
  const response = await driveFetch(accessToken, `/files?${params.toString()}`);
  if (!response.ok) {
    throw new DriveApiError(`Drive search failed (${response.status})`);
  }
  const data = (await response.json()) as { files?: Array<Record<string, string>> };
  return data.files ?? [];
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
  parentId?: string,
  // Private custom metadata (never shown in the Drive UI, only readable via
  // the API by the app that set it) — used to tag a client's folder with
  // its Centro client id, so a later lookup can confirm "this folder really
  // is this client's" instead of relying on a name match alone, which a
  // same-named different client could collide with. See ensureClientFolder
  // in src/lib/storage/driveAdapter.ts.
  properties?: Record<string, string>
): Promise<DriveFolderRef> {
  const response = await driveFetch(accessToken, "/files?fields=id,name", {
    method: "POST",
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: parentId ? [parentId] : undefined,
      ...(properties ? { properties } : {}),
    }),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to create Drive folder (${response.status})`);
  }
  const data = (await response.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

// Scoped strictly to `parentId` (never a global Drive search — the
// drive.file scope wouldn't allow one to see anything meaningful anyway).
// Returns every matching folder, not just one, so callers can both (a)
// reuse a single existing match and (b) detect genuine duplicates left over
// from a race, which mergeDuplicateClientFolders below cleans up.
export async function findFoldersByName(
  accessToken: string,
  parentId: string,
  name: string
): Promise<DriveFolderRef[]> {
  const query = `'${parentId}' in parents and name='${escapeDriveQueryValue(name)}' and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`;
  const files = await listDriveItems(accessToken, query, "id,name");
  return files.map((f) => ({ id: f.id, name: f.name }));
}

// The authoritative "is this folder really this client's" check — a name
// match alone can't distinguish two different clients who happen to share a
// display name (see the collision-suffix logic in ensureClientFolder).
// Property values in a Drive query must themselves be quoted+escaped the
// same as any other string literal.
export async function findFolderByClientProperty(
  accessToken: string,
  parentId: string,
  clientId: string
): Promise<DriveFolderRef | null> {
  const query = `'${parentId}' in parents and mimeType='${FOLDER_MIME_TYPE}' and trashed=false and properties has { key='centroClientId' and value='${escapeDriveQueryValue(clientId)}' }`;
  const files = await listDriveItems(accessToken, query, "id,name");
  return files[0] ? { id: files[0].id, name: files[0].name } : null;
}

// Non-folder files directly inside a folder — used by
// mergeDuplicateClientFolders to move every file out of a duplicate before
// it's trashed, and by resolveUniqueFileName's overwrite check.
export async function listFolderFiles(accessToken: string, folderId: string): Promise<DriveFileRef[]> {
  const query = `'${folderId}' in parents and mimeType!='${FOLDER_MIME_TYPE}' and trashed=false`;
  const files = await listDriveItems(accessToken, query, "id,name,webViewLink");
  return files.map((f) => ({ id: f.id, name: f.name, webViewLink: f.webViewLink ?? null }));
}

// Drive files don't have a single "parent folder" field to overwrite —
// moving means adding the new parent and removing the old one in the same
// call (Drive API v3's documented move pattern).
export async function moveDriveFile(
  accessToken: string,
  fileId: string,
  fromParentId: string,
  toParentId: string
): Promise<void> {
  const params = new URLSearchParams({ addParents: toParentId, removeParents: fromParentId, fields: "id" });
  const response = await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    method: "PATCH",
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to move Drive file (${response.status})`);
  }
}

// Tags (or re-tags) an existing folder with the app's private client-id
// property — used both to adopt a legacy pre-tagging folder and to
// guarantee the surviving folder after a duplicate merge is tagged, whether
// or not it already was.
export async function setFolderClientProperty(accessToken: string, folderId: string, clientId: string): Promise<void> {
  const response = await driveFetch(accessToken, `/files/${encodeURIComponent(folderId)}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { centroClientId: clientId } }),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to tag Drive folder (${response.status})`);
  }
}

// Soft delete (moves to Drive's own Trash) rather than a permanent
// files.delete — a duplicate-folder merge is exactly the kind of operation
// that should stay reversible if something about the merge turns out to be
// wrong, for as long as Drive's own trash retention allows.
export async function trashDriveFolder(accessToken: string, folderId: string): Promise<void> {
  const response = await driveFetch(accessToken, `/files/${encodeURIComponent(folderId)}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true }),
  });
  if (!response.ok) {
    throw new DriveApiError(`Failed to trash Drive folder (${response.status})`);
  }
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
