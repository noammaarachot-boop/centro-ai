import { describe, expect, it } from "vitest";
import {
  buildPhoneNumberWebhookUrl,
  generateWebhookVerifyToken,
  WEBHOOK_CALLBACK_URL,
} from "./webhookUrls";

// Per-phone-number webhook override (Meta "Webhook overrides") — the URL a
// manually-connected organization's inbound events are routed to instead
// of the shared app-level endpoint.

describe("buildPhoneNumberWebhookUrl", () => {
  it("derives from the same origin as the app-level callback URL — one source of truth for the domain", () => {
    expect(buildPhoneNumberWebhookUrl("436563892876866")).toBe(`${WEBHOOK_CALLBACK_URL}/436563892876866`);
  });

  it("is a real absolute https URL Meta can call", () => {
    const url = new URL(buildPhoneNumberWebhookUrl("436563892876866"));
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/api/webhooks/whatsapp/436563892876866");
  });

  it("stays well within Meta's 200-character override limit for a real 15-16 digit phone number id", () => {
    expect(buildPhoneNumberWebhookUrl("436563892876866").length).toBeLessThan(200);
  });

  it("encodes the phone number id rather than interpolating it raw (no path injection)", () => {
    const url = buildPhoneNumberWebhookUrl("abc/../../evil");
    expect(url).not.toContain("/../");
    expect(url).toBe(`${WEBHOOK_CALLBACK_URL}/abc%2F..%2F..%2Fevil`);
  });

  it("throws rather than silently registering a URL Meta would reject as too long", () => {
    expect(() => buildPhoneNumberWebhookUrl("9".repeat(300))).toThrow(/200-character/);
  });
});

describe("generateWebhookVerifyToken", () => {
  it("returns a fresh, unguessable token every call", () => {
    const a = generateWebhookVerifyToken();
    const b = generateWebhookVerifyToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("is URL-safe, so it survives being copied out of the owner screen and pasted into Meta", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateWebhookVerifyToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
