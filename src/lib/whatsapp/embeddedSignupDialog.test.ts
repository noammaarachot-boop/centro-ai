import { describe, expect, it, vi } from "vitest";

vi.mock("./config", async () => {
  const actual = await vi.importActual<typeof import("./config")>("./config");
  return { ...actual, getWhatsAppConfig: () => ({ appId: "app-1", appSecret: "s" }) };
});

const { buildEmbeddedSignupDialogUrl } = await import("./embeddedSignup");

/**
 * Regression — a repeat signup never offered the account picker.
 *
 * Meta saw the app was already authorised for that Facebook user, showed only
 * "you previously linked Centro AI Messaging — continue as …", and returned a
 * code carrying the FIRST grant's permissions. No WhatsApp Business Account
 * or phone number could be chosen, so the token came back scoped to whatever
 * WABA an earlier signup happened to cover — and the reconnect then failed at
 * phone-lookup against an account nobody had selected.
 */
const base = {
  appId: "app-1",
  configId: "config-1",
  redirectUri: "https://www.centro-ai.co.il/api/auth/whatsapp/oauth",
  state: "signed-state",
};

const paramsOf = (url: string) => new URL(url).searchParams;

describe("buildEmbeddedSignupDialogUrl", () => {
  it("asks Meta to re-run the flow instead of silently reusing a grant", () => {
    expect(paramsOf(buildEmbeddedSignupDialogUrl({ ...base, rerequest: true })).get("auth_type")).toBe(
      "rerequest"
    );
  });

  it("omits auth_type when not requested, rather than sending an empty value", () => {
    expect(paramsOf(buildEmbeddedSignupDialogUrl(base)).has("auth_type")).toBe(false);
  });

  it("carries the Embedded Signup configuration, not a bare OAuth login", () => {
    const p = paramsOf(buildEmbeddedSignupDialogUrl(base));

    // Without config_id + this response-type override Meta runs a generic
    // Facebook login, which is what produced a "continue as" screen with no
    // WhatsApp account selection at all.
    expect(p.get("config_id")).toBe("config-1");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("override_default_response_type")).toBe("true");
    expect(JSON.parse(p.get("extras")!)).toEqual({
      setup: {},
      featureType: "",
      sessionInfoVersion: "3",
    });
  });

  it("passes the signed state through untouched — it carries the organization", () => {
    expect(paramsOf(buildEmbeddedSignupDialogUrl(base)).get("state")).toBe("signed-state");
  });

  it("uses the exact redirect_uri it was given (Meta matches it byte-for-byte)", () => {
    expect(paramsOf(buildEmbeddedSignupDialogUrl(base)).get("redirect_uri")).toBe(base.redirectUri);
  });
});
