import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhookSignature";

const APP_SECRET = "test-app-secret";

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf-8").digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_WHATSAPP_APP_ID = "test-app-id";
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_SYSTEM_USER_TOKEN = "test-token";
  });

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a body that was modified after signing", () => {
    const original = JSON.stringify({ entry: [] });
    const signature = sign(original);
    const tampered = JSON.stringify({ entry: [{ injected: true }] });
    expect(verifyWebhookSignature(tampered, signature)).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const body = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature(body, sign(body, "wrong-secret"))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature("{}", null)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = "{}";
    const rawHex = createHmac("sha256", APP_SECRET).update(body, "utf-8").digest("hex");
    expect(verifyWebhookSignature(body, rawHex)).toBe(false);
  });

  it("rejects a signature of the wrong length rather than throwing", () => {
    expect(verifyWebhookSignature("{}", "sha256=abcd")).toBe(false);
  });
});
