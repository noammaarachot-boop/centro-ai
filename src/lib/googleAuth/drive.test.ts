import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadDriveFile, downloadDriveFile, updateDriveFileContent, findFoldersByName } from "./drive";

/**
 * Phase 3.3 remediation — every outbound Drive fetch call now carries a
 * request timeout (AbortSignal), so a hung request fails fast enough for
 * withRetry to actually retry it instead of silently consuming the whole
 * calling function's time budget. No test file existed for this module
 * before; these are structural checks (the signal is wired in), not a
 * full behavioral suite for drive.ts.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("drive.ts — every outbound call carries a request timeout", () => {
  it("driveFetch (metadata calls, e.g. findFoldersByName)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ files: [] }) });
    await findFoldersByName("token", "parent-1", "folder-name");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uploadDriveFile", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "f1", name: "a.pdf" }) });
    await uploadDriveFile("token", { name: "a.pdf", parentId: "p1", mimeType: "application/pdf", content: Buffer.from("x") });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("downloadDriveFile (both the metadata read and the content fetch)", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ mimeType: "application/pdf" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    await downloadDriveFile("token", "file-1");
    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("updateDriveFileContent", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await updateDriveFileContent("token", "file-1", Buffer.from("x"), "application/pdf");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
