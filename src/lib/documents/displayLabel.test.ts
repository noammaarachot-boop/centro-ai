import { describe, expect, it } from "vitest";
import { ATTACHMENT_PLACEHOLDER_TEXT, resolveDocumentDisplayLabel, resolveMessageDisplayBody } from "./displayLabel";

describe("resolveDocumentDisplayLabel — never falls back to a raw storage filename", () => {
  it("prefers the document's own displayLabel when set", () => {
    expect(resolveDocumentDisplayLabel("תעודת זהות", "מסמך אחר")).toBe("תעודת זהות");
  });

  it("falls back to the matched requirement's name when displayLabel is null", () => {
    expect(resolveDocumentDisplayLabel(null, "תלוש שכר")).toBe("תלוש שכר");
  });

  it("falls back to a generic honest label when neither is available", () => {
    expect(resolveDocumentDisplayLabel(null, null)).toBe("מסמך שהתקבל");
    expect(resolveDocumentDisplayLabel(undefined, undefined)).toBe("מסמך שהתקבל");
  });

  it("treats a blank/whitespace-only label as absent, never renders empty text", () => {
    expect(resolveDocumentDisplayLabel("   ", "תלוש שכר")).toBe("תלוש שכר");
    expect(resolveDocumentDisplayLabel("", "")).toBe("מסמך שהתקבל");
  });
});

describe("resolveMessageDisplayBody — the conversation thread's display-time upgrade", () => {
  it("upgrades the generic attachment placeholder to the document's real label once known", () => {
    expect(resolveMessageDisplayBody(ATTACHMENT_PLACEHOLDER_TEXT, "תעודת זהות")).toBe("[קובץ מצורף: תעודת זהות]");
  });

  it("leaves the placeholder as-is when no resolved label is available yet (not yet classified)", () => {
    expect(resolveMessageDisplayBody(ATTACHMENT_PLACEHOLDER_TEXT, undefined)).toBe(ATTACHMENT_PLACEHOLDER_TEXT);
  });

  it("never touches a message that isn't the bare placeholder (a real caption, or ordinary text)", () => {
    expect(resolveMessageDisplayBody("שלום, מצורף המסמך", "תעודת זהות")).toBe("שלום, מצורף המסמך");
    expect(resolveMessageDisplayBody("סיימתי", undefined)).toBe("סיימתי");
  });

  it("never produces a string containing a raw storage filename", () => {
    const upgraded = resolveMessageDisplayBody(ATTACHMENT_PLACEHOLDER_TEXT, "דרכון");
    expect(upgraded).not.toMatch(/wamid|\.(jpg|jpeg|png|pdf)/i);
  });
});
