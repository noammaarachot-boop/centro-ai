import { describe, expect, it, vi } from "vitest";

const getOrganization = vi.fn();
const getValidAccessToken = vi.fn();
const getDriveFolder = vi.fn();
const getDriveFile = vi.fn();

vi.mock("@/lib/data/organizations", () => ({
  getOrganization: (...args: unknown[]) => getOrganization(...args),
}));
vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return {
    ...actual,
    getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args),
  };
});
vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return {
    ...actual,
    getDriveFolder: (...args: unknown[]) => getDriveFolder(...args),
    getDriveFile: (...args: unknown[]) => getDriveFile(...args),
  };
});

const { createDriveTools } = await import("./drive");
const { GoogleNotConnectedError } = await import("@/lib/googleAuth/driveTokens");
const { DriveApiError } = await import("@/lib/googleAuth/drive");

const CTX = { organizationId: "org-1", actingUserId: "user-1" };

describe("get_drive_folder_info", () => {
  it("returns connected:false without throwing when the org never selected a folder", async () => {
    getOrganization.mockResolvedValueOnce({ googleDriveFolderId: null });
    const tools = createDriveTools(CTX);
    const result = await tools.get_drive_folder_info.execute!({}, {} as never);
    expect(result).toEqual({ connected: false });
    expect(getValidAccessToken).not.toHaveBeenCalled();
  });

  it("returns connected:false (not a thrown error) when Google isn't connected", async () => {
    getOrganization.mockResolvedValueOnce({ googleDriveFolderId: "folder-1" });
    getValidAccessToken.mockRejectedValueOnce(new GoogleNotConnectedError());
    const tools = createDriveTools(CTX);
    const result = await tools.get_drive_folder_info.execute!({}, {} as never);
    expect(result).toMatchObject({ connected: false });
  });

  it("returns the real folder when everything is connected", async () => {
    getOrganization.mockResolvedValueOnce({ googleDriveFolderId: "folder-1" });
    getValidAccessToken.mockResolvedValueOnce("token-abc");
    getDriveFolder.mockResolvedValueOnce({ id: "folder-1", name: "Real Folder" });
    const tools = createDriveTools(CTX);
    const result = await tools.get_drive_folder_info.execute!({}, {} as never);
    expect(result).toEqual({ connected: true, folder: { id: "folder-1", name: "Real Folder" } });
  });

  it("propagates a genuinely unexpected error rather than swallowing it", async () => {
    getOrganization.mockResolvedValueOnce({ googleDriveFolderId: "folder-1" });
    getValidAccessToken.mockRejectedValueOnce(new Error("unexpected"));
    const tools = createDriveTools(CTX);
    await expect(tools.get_drive_folder_info.execute!({}, {} as never)).rejects.toThrow("unexpected");
  });
});

describe("get_drive_file_info", () => {
  it("returns found:false (not a thrown error) when the file is missing/trashed", async () => {
    getValidAccessToken.mockResolvedValueOnce("token-abc");
    getDriveFile.mockRejectedValueOnce(new DriveApiError("File was deleted from Drive."));
    const tools = createDriveTools(CTX);
    const result = await tools.get_drive_file_info.execute!({ driveFileId: "file-1" }, {} as never);
    expect(result).toMatchObject({ found: false });
  });

  it("returns the real file when found", async () => {
    getValidAccessToken.mockResolvedValueOnce("token-abc");
    getDriveFile.mockResolvedValueOnce({ id: "file-1", name: "doc.pdf", webViewLink: "https://drive.google.com/x" });
    const tools = createDriveTools(CTX);
    const result = await tools.get_drive_file_info.execute!({ driveFileId: "file-1" }, {} as never);
    expect(result).toEqual({
      found: true,
      file: { id: "file-1", name: "doc.pdf", webViewLink: "https://drive.google.com/x" },
    });
  });
});
