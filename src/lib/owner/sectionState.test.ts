import { describe, expect, it } from "vitest";
import {
  resolveSectionOpen,
  sectionStorageKey,
  serializeSectionState,
} from "./sectionState";

// The requirement: the accordion is the USER's. A server action inside a
// section, or a page refresh, must never change what they chose.

describe("sectionStorageKey", () => {
  it("scopes state per organization AND per section, so they never collide", () => {
    const a = sectionStorageKey("org-1", "connections");
    const b = sectionStorageKey("org-1", "templates");
    const c = sectionStorageKey("org-2", "connections");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("is stable for the same organization and section", () => {
    expect(sectionStorageKey("org-1", "advanced")).toBe(sectionStorageKey("org-1", "advanced"));
  });
});

describe("resolveSectionOpen", () => {
  it("uses defaultOpen only when the user has NO stored preference", () => {
    expect(resolveSectionOpen(null, true)).toBe(true);
    expect(resolveSectionOpen(null, false)).toBe(false);
  });

  it("a section the user CLOSED stays closed, even when defaultOpen would open it", () => {
    // e.g. "חיבורים" defaults open when something needs attention — but a
    // deliberate close must survive the next render and the next refresh.
    expect(resolveSectionOpen("0", true)).toBe(false);
  });

  it("a section the user OPENED stays open, even when defaultOpen is false", () => {
    // e.g. "פרטים מתקדמים" is closed by default; once opened it stays open
    // across an internal action and a refresh.
    expect(resolveSectionOpen("1", false)).toBe(true);
  });

  it("treats an unrecognized stored value as no preference rather than guessing", () => {
    expect(resolveSectionOpen("yes", true)).toBe(true);
    expect(resolveSectionOpen("", false)).toBe(false);
  });

  it("round-trips: what is written back is what is read next time", () => {
    for (const open of [true, false]) {
      expect(resolveSectionOpen(serializeSectionState(open), !open)).toBe(open);
    }
  });
});

// The four sections on the organization page, each independent.
describe("independence across sections", () => {
  it("closing one section does not affect the state of another", () => {
    const state: Record<string, string> = {
      [sectionStorageKey("org-1", "connections")]: "0",
      [sectionStorageKey("org-1", "templates")]: "1",
    };

    expect(resolveSectionOpen(state[sectionStorageKey("org-1", "connections")], true)).toBe(false);
    expect(resolveSectionOpen(state[sectionStorageKey("org-1", "templates")], false)).toBe(true);
    // Untouched sections still fall back to their own default.
    expect(resolveSectionOpen(state[sectionStorageKey("org-1", "advanced")] ?? null, false)).toBe(false);
    expect(resolveSectionOpen(state[sectionStorageKey("org-1", "activity")] ?? null, false)).toBe(false);
  });

  it("one organization's choices never leak into another's", () => {
    const state: Record<string, string> = {
      [sectionStorageKey("org-1", "connections")]: "1",
    };
    expect(resolveSectionOpen(state[sectionStorageKey("org-2", "connections")] ?? null, false)).toBe(
      false
    );
  });
});
