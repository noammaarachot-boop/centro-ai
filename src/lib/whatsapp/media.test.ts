import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "fake-token" }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const { downloadMedia } = await import("./media");

describe("downloadMedia", () => {
  it("resolves the metadata lookup then downloads the file from the returned URL", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn.example/file", mime_type: "image/jpeg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer });

    const result = await downloadMedia("media-1");

    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.from(result.bytes).toString()).toBe("bytes");
  });
});

describe("downloadMedia — Phase 7: request timeouts", () => {
  it("wires an AbortSignal into both the metadata lookup and the file download", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn.example/file", mime_type: "image/jpeg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer });

    await downloadMedia("media-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
