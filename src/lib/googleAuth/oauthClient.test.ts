import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.GOOGLE_CLIENT_SECRET = "secret-1";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://example.com/callback";
});

vi.mock("./config", () => ({
  getGoogleOAuthConfig: () => ({ clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://example.com/callback" }),
  GOOGLE_DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.file",
}));

const { buildAuthorizationUrl, exchangeCodeForTokens, refreshAccessToken, revokeToken } = await import("./oauthClient");

// hl=he — an officially documented Google OAuth 2.0 authorization
// parameter, added so Google's own consent screen displays in Hebrew.
// Must never affect client_id/redirect_uri/scope/response_type, the
// actual identity of the request.
describe("buildAuthorizationUrl — Hebrew consent-screen language", () => {
  it("sets hl=he without changing any other parameter", () => {
    const url = new URL(buildAuthorizationUrl("state-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("hl")).toBe("he");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});

/**
 * Phase 3.3 remediation — the Google token endpoint calls (exchange,
 * refresh, revoke) now carry a request timeout too, since every Drive
 * operation depends on a valid token. Structural checks only — no prior
 * test file existed for this module.
 */
describe("oauthClient.ts — every outbound token request carries a request timeout", () => {
  it("exchangeCodeForTokens", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "a", expires_in: 3600 }) });
    await exchangeCodeForTokens("code-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refreshAccessToken", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "a", expires_in: 3600 }) });
    await refreshAccessToken("refresh-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("revokeToken", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await revokeToken("token-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
