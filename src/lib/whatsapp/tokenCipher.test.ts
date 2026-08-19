import { beforeEach, describe, expect, it } from "vitest";
import { decryptWhatsAppToken, encryptWhatsAppToken } from "./tokenCipher";

describe("whatsapp tokenCipher", () => {
  beforeEach(() => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  });

  it("round-trips a token through encrypt then decrypt", () => {
    const plaintext = "EAAG_example_whatsapp_access_token";
    const encrypted = encryptWhatsAppToken(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptWhatsAppToken(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "EAAG_another_token";
    expect(encryptWhatsAppToken(plaintext)).not.toBe(encryptWhatsAppToken(plaintext));
  });

  it("throws on a tampered ciphertext instead of silently returning wrong data", () => {
    const encrypted = encryptWhatsAppToken("secret-value");
    const [iv, tag, ciphertext] = encrypted.split(".");
    const tampered = `${iv}.${tag}.${ciphertext.slice(0, -4)}abcd`;
    expect(() => decryptWhatsAppToken(tampered)).toThrow();
  });

  it("throws a clear error when the encryption key is missing", () => {
    delete process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptWhatsAppToken("x")).toThrow(/WHATSAPP_TOKEN_ENCRYPTION_KEY/);
  });

  it("throws a clear error when the encryption key is the wrong length", () => {
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptWhatsAppToken("x")).toThrow(/32 bytes/);
  });

  it("uses a genuinely different key than GOOGLE_TOKEN_ENCRYPTION_KEY — a value encrypted with one key doesn't decrypt with the other", async () => {
    const whatsappEncrypted = encryptWhatsAppToken("shared-plaintext");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    const { decryptToken } = await import("@/lib/googleAuth/tokenCipher");
    expect(() => decryptToken(whatsappEncrypted)).toThrow();
  });
});
