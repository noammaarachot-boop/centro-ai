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

// Per-organization credentials — a manually-connected organization has its
// own token, and silently retrying with the shared one would either fail
// anyway (it has no access to that WABA) or mask a real permissions
// problem that would resurface later as an unexplained send failure.
describe("subscribeToWabaWebhooks — shared-token fallback is opt-out for organizations with their own credentials", () => {
  it("does NOT retry with the shared system token when the fallback is disabled — one attempt, the org's own token only", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "no permission" });

    const result = await subscribeToWabaWebhooks("waba-1", "org-own-token", {
      allowSharedTokenFallback: false,
    });

    expect(result).toBe(false); // a truthful failure, not a masked success
    expect(fetchMock).toHaveBeenCalledTimes(1); // never a second attempt with the shared token
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer org-own-token");
  });

  it("tries CENTRO's shared token FIRST — it is the app being subscribed", async () => {
    // POST /{waba}/subscribed_apps has no parameter naming an app: it
    // subscribes whichever app ISSUED the token. The organization's token was
    // tried first, returned 200 (it subscribed the app that minted it) and
    // the loop broke on that success — so Centro's app was never attached and
    // Meta delivered that office's inbound messages elsewhere, while outbound
    // kept working because sending needs no subscription. The WABA remains
    // the organization's throughout; this is webhook routing only.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ whatsapp_business_api_data: { id: "app-1" } }] }),
      text: async () => "",
    });

    const result = await subscribeToWabaWebhooks("waba-1", "org-own-token");

    expect(result).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fake-system-token");
  });

  it("a 200 that attached SOMEBODY ELSE'S app is not treated as success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ whatsapp_business_api_data: { id: "2293192351503059" } }] }),
      text: async () => "",
    });

    const result = await subscribeToWabaWebhooks("waba-1", "org-own-token");

    expect(result, "a subscription that routes nothing to us is not a success").toBe(false);
  });

  it("falls through to the organization's token — in Embedded Signup that IS Centro-app-issued", async () => {
    // The app-level field subscription that follows sends no Authorization
    // header (it authenticates with appId|appSecret in the body), so this
    // must not assume one is present.
    fetchMock.mockImplementation(async (_url: string, init?: { headers?: { Authorization?: string } }) =>
      init?.headers?.Authorization === "Bearer signup-user-token"
        ? {
            ok: true,
            json: async () => ({ data: [{ whatsapp_business_api_data: { id: "app-1" } }] }),
            text: async () => "",
          }
        : { ok: false, status: 403, text: async () => "no permission", json: async () => ({}) }
    );

    expect(await subscribeToWabaWebhooks("waba-1", "signup-user-token")).toBe(true);
  });
});
