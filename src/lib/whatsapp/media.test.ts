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

// Manual per-organization WhatsApp connection — a media id from a
// manually-connected organization's own WABA is only downloadable with
// THAT organization's token; the shared system token has no permission on
// it. Proves the org-specific token, when passed, authorizes both Graph
// API calls instead of the shared one, and that every existing caller
// (webhook messages for an Embedded-Signup-connected organization) keeps
// using the shared token exactly as before.
describe("downloadMedia — per-organization Access Token", () => {
  it("uses the organization's own access token for both requests when one is provided", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn.example/file", mime_type: "image/jpeg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer });

    await downloadMedia("media-1", "org-own-token");

    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.headers.Authorization).toBe("Bearer org-own-token");
    }
  });

  it("falls back to WHATSAPP_SYSTEM_USER_TOKEN when no organization token is passed", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn.example/file", mime_type: "image/jpeg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer });

    await downloadMedia("media-1");

    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.headers.Authorization).toBe("Bearer fake-token");
    }
  });
});
