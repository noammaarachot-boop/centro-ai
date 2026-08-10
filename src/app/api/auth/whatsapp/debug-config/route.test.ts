import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ id: "app-1", name: "Centro" }) });
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn().mockResolvedValue({ userId: "u1", organizationId: "org-1" }),
}));

vi.mock("@/lib/whatsapp/config", () => ({
  getWhatsAppConfig: () => ({
    appId: "app-1",
    appSecret: "secret-1",
    oauthRedirectUri: "https://www.centro-ai.co.il/api/auth/whatsapp/oauth",
    systemUserToken: "fake-system-token",
  }),
  GRAPH_API_BASE: "https://graph.example/v1",
  GRAPH_API_VERSION: "v1",
}));

const { GET } = await import("./route");

describe("GET /api/auth/whatsapp/debug-config — Phase 7: request timeout", () => {
  it("wires an AbortSignal into the Graph API app-check call", async () => {
    await GET();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
