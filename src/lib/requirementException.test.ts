import { describe, expect, it } from "vitest";
import { resolveExceptionTarget } from "./requirementException";

// "אין לי את המסמך הזה" — matching which outstanding requirement a client's
// free-text report refers to. Pure function, directly unit-testable.

describe("resolveExceptionTarget", () => {
  it("nothing outstanding at all -> none_outstanding (never opens an exception against nothing)", () => {
    expect(resolveExceptionTarget([], null)).toEqual({ kind: "none_outstanding" });
  });

  it("exactly one outstanding requirement -> matched, even with no mentioned document type", () => {
    const outstanding = [{ id: "r1", name: "אישור שכירות" }];
    expect(resolveExceptionTarget(outstanding, null)).toEqual({ kind: "matched", requirementId: "r1" });
  });

  it("several outstanding, no mentioned document type -> ambiguous, never guesses", () => {
    const outstanding = [
      { id: "r1", name: "אישור שכירות" },
      { id: "r2", name: "תעודת זהות" },
    ];
    expect(resolveExceptionTarget(outstanding, null)).toEqual({ kind: "ambiguous" });
  });

  it("several outstanding, a confidently-matching mentioned document type -> matched", () => {
    const outstanding = [
      { id: "r1", name: "אישור שכירות" },
      { id: "r2", name: "תעודת זהות" },
    ];
    expect(resolveExceptionTarget(outstanding, "אישור שכירות")).toEqual({ kind: "matched", requirementId: "r1" });
  });

  it("several outstanding, a mentioned document type matching none confidently -> ambiguous", () => {
    const outstanding = [
      { id: "r1", name: "אישור שכירות" },
      { id: "r2", name: "תעודת זהות" },
    ];
    expect(resolveExceptionTarget(outstanding, "משהו אחר לגמרי")).toEqual({ kind: "ambiguous" });
  });
});
