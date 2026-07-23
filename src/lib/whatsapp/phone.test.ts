import { describe, expect, it } from "vitest";
import { toE164 } from "./phone";

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
