import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./tokenCipher";

describe("tokenCipher", () => {
  beforeEach(() => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a token through encrypt then decrypt", () => {
    const plaintext = "ya29.a0AfH6SMB_example_access_token";
    const encrypted = encryptToken(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "1//0gExampleRefreshToken";
    expect(encryptToken(plaintext)).not.toBe(encryptToken(plaintext));
  });

  it("throws on a tampered ciphertext instead of silently returning wrong data", () => {
    const encrypted = encryptToken("secret-value");
    const [iv, tag, ciphertext] = encrypted.split(".");
    const tampered = `${iv}.${tag}.${ciphertext.slice(0, -4)}abcd`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws a clear error when the encryption key is missing", () => {
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("x")).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
  });

  it("throws a clear error when the encryption key is the wrong length", () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });
});
