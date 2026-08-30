import { beforeAll, describe, expect, it } from "vitest";
import { decodeWhatsAppOAuthState, encodeWhatsAppOAuthState } from "./oauthState";

/**
 * The organization an owner-initiated reconnect targets must survive the
 * round trip to Meta unforgeably.
 *
 * The owner session cookie is scoped to /owner and is never sent to the OAuth
 * callback, so the callback cannot re-check it. The authorisation therefore
 * has to travel inside the signed state — which means tampering with it must
 * be detectable, or one organization's reconnect could write another's
 * credentials.
 */
beforeAll(() => {
  process.env.WHATSAPP_APP_SECRET = "test-signing-secret";
});

const base = {
  csrf: "csrf-1",
  returnTo: "/owner/organizations/org-a",
  redirectUri: "https://www.centro-ai.co.il/api/auth/whatsapp/oauth",
  exp: Date.now() + 60_000,
};

describe("organizationId in the OAuth state", () => {
  it("round-trips intact", () => {
    const state = encodeWhatsAppOAuthState({ ...base, organizationId: "org-a" });

    expect(decodeWhatsAppOAuthState(state)?.organizationId).toBe("org-a");
  });

  it("is absent for the ordinary employee flow", () => {
    expect(decodeWhatsAppOAuthState(encodeWhatsAppOAuthState(base))?.organizationId).toBeUndefined();
  });

  it("cannot be swapped for another tenant's id", () => {
    const state = encodeWhatsAppOAuthState({ ...base, organizationId: "org-a" });
    const [body, signature] = state.split(".");

    // Re-encode the payload with a different organization, keeping the
    // original signature — the exact attack this protects against.
    const tampered = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    tampered.organizationId = "org-b";
    const forged = `${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}.${signature}`;

    expect(decodeWhatsAppOAuthState(forged), "a tampered state must not decode").toBeNull();
  });

  it("cannot be re-signed without the app secret", () => {
    const state = encodeWhatsAppOAuthState({ ...base, organizationId: "org-a" });
    const [body] = state.split(".");
    const forged = `${body}.${Buffer.from("guessed-signature").toString("base64url")}`;

    expect(decodeWhatsAppOAuthState(forged)).toBeNull();
  });

  it("still rejects an expired state carrying an organization", () => {
    const stale = encodeWhatsAppOAuthState({
      ...base,
      exp: Date.now() - 1,
      organizationId: "org-a",
    });

    // Expiry is enforced inside decode itself, so a stale state cannot carry
    // an organization through at all — no caller has to remember to check.
    expect(decodeWhatsAppOAuthState(stale)).toBeNull();
  });
});
