import { createHmac, timingSafeEqual } from "node:crypto";
import { getWhatsAppConfig } from "./config";

// Meta signs every webhook POST body with HMAC-SHA256 keyed by the App
// Secret, sent as `X-Hub-Signature-256: sha256=<hex>` — verifying this is
// the only way to confirm a request claiming to be a WhatsApp webhook
// actually came from Meta, since this route has no session of its own
// (Meta's servers don't have a Centro login). Must run against the exact
// raw request body — parsing to JSON first and re-serializing would
// produce a different byte sequence and always fail verification.
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const { appSecret } = getWhatsAppConfig();
  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf-8").digest("hex");
  const providedHex = signatureHeader.slice("sha256=".length);

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const providedBuffer = Buffer.from(providedHex, "hex");
  // Lengths must match before timingSafeEqual — it throws on mismatched
  // buffer lengths rather than returning false.
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
