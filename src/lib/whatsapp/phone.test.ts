import { describe, expect, it } from "vitest";
import { isSamePhoneNumber, toE164 } from "./phone";

describe("toE164", () => {
  it("converts an Israeli local number (leading 0) to E.164", () => {
    expect(toE164("050-1234567")).toBe("+972501234567");
  });

  it("strips spaces and dashes from a local number", () => {
    expect(toE164("050 123 4567")).toBe("+972501234567");
  });

  it("passes through an already-E.164 number unchanged", () => {
    expect(toE164("+972501234567")).toBe("+972501234567");
  });

  it("converts an international-prefix (00) number to E.164", () => {
    expect(toE164("00972501234567")).toBe("+972501234567");
  });

  it("adds the leading + to a bare country-code number", () => {
    expect(toE164("972501234567")).toBe("+972501234567");
  });

  it("handles a real non-Israeli E.164 number (the Meta test number format)", () => {
    expect(toE164("+1 555-140-0970")).toBe("+15551400970");
  });

  it("returns null for an empty string", () => {
    expect(toE164("")).toBeNull();
  });

  it("returns null for input with no digits at all", () => {
    expect(toE164("abc")).toBeNull();
  });

  it("returns null for a number too short to be real", () => {
    expect(toE164("123")).toBeNull();
  });

  it("returns null for a number exceeding E.164's max length", () => {
    expect(toE164("+1234567890123456")).toBeNull();
  });
});

// Regression — QA found that a client's phone was checked for uniqueness as
// a raw string while inbound WhatsApp routing matched it normalized. The
// same real number could therefore be saved once per formatting; five rows
// for +972509998877 were created through the real UI, after which
// matchClientByPhone resolved an inbound message to whichever row its scan
// reached first.
describe("isSamePhoneNumber", () => {
  it("treats every formatting of one real number as the same number", () => {
    const variants = [
      "0509998877",
      "+972509998877",
      "+972-50-999-8877",
      "972509998877",
      "050-999-8877",
      "050 999 8877",
      "00972509998877",
    ];
    for (const variant of variants) {
      expect(isSamePhoneNumber("0509998877", variant), variant).toBe(true);
      // Symmetric, so it does not matter which side the stored value is on.
      expect(isSamePhoneNumber(variant, "0509998877"), `${variant} reversed`).toBe(true);
    }
  });

  it("keeps genuinely different numbers apart", () => {
    expect(isSamePhoneNumber("0509998877", "0509998878")).toBe(false);
    expect(isSamePhoneNumber("+972509998877", "+15551400970")).toBe(false);
  });

  it("falls back to exact comparison when a value cannot be normalized", () => {
    // Unparseable input is never collapsed with something it is not...
    expect(isSamePhoneNumber("abc", "0509998877")).toBe(false);
    expect(isSamePhoneNumber("123", "456")).toBe(false);
    // ...but two identical unparseable values are still the same value.
    expect(isSamePhoneNumber("abc", "abc")).toBe(true);
    expect(isSamePhoneNumber(" 0509998877 ", "0509998877")).toBe(true);
  });
});
