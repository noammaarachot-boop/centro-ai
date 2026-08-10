import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({
    appId: "app-1",
    appSecret: "secret-1",
    oauthRedirectUri: "https://www.centro-ai.co.il/api/auth/whatsapp/oauth",
    systemUserToken: "fake-system-token",
    webhookVerifyToken: "fake-verify-token",
  }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const { exchangeSignupCode, resolveWabaIdFromToken, subscribeToWabaWebhooks, WhatsAppSignupError } =
  await import("./embeddedSignup");

function debugTokenResponse(targetIds: string[]) {
  return {
    ok: true,
    json: async () => ({
      data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: targetIds }] },
    }),
  };
}

describe("resolveWabaIdFromToken — single WABA (the common case)", () => {
  it("resolves the one WABA id granted to the token", async () => {
    fetchMock.mockResolvedValue(debugTokenResponse(["waba-1"]));
    await expect(resolveWabaIdFromToken("token")).resolves.toBe("waba-1");
  });
});

describe("resolveWabaIdFromToken — Phase 2.2: never silently picks among several WABAs", () => {
  it("throws a clear WhatsAppSignupError instead of connecting to target_ids[0] when the token was granted access to more than one WABA", async () => {
    fetchMock.mockResolvedValue(debugTokenResponse(["waba-1", "waba-2"]));
    await expect(resolveWabaIdFromToken("token")).rejects.toBeInstanceOf(WhatsAppSignupError);
    await expect(resolveWabaIdFromToken("token")).rejects.toThrow(/2 WhatsApp Business Accounts/);
  });

  it("the disambiguation error carries the waba-resolve step", async () => {
    fetchMock.mockResolvedValue(debugTokenResponse(["waba-1", "waba-2"]));
    try {
      await resolveWabaIdFromToken("token");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppSignupError);
      expect((error as InstanceType<typeof WhatsAppSignupError>).step).toBe("waba-resolve");
    }
  });

  it("still throws (not connect) when the token has no granular scope at all", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    await expect(resolveWabaIdFromToken("token")).rejects.toBeInstanceOf(WhatsAppSignupError);
  });
});

describe("Phase 7: request timeouts on every outbound Meta call in this module", () => {
  it("resolveWabaIdFromToken's debug_token call carries an AbortSignal", async () => {
    fetchMock.mockResolvedValue(debugTokenResponse(["waba-1"]));
    await resolveWabaIdFromToken("token");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("exchangeSignupCode's code-exchange call carries an AbortSignal", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "user-token" }) });
    await exchangeSignupCode("code-1", [], { onlyPreferred: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("subscribeToWabaWebhooks' WABA-level and app-level calls both carry an AbortSignal", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "" });
    await subscribeToWabaWebhooks("waba-1");
    expect(fetchMock).toHaveBeenCalledTimes(2); // WABA-level subscribe, then app-level field subscription
    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
