import { describe, expect, it } from "vitest";
import {
  computeContinuationConfidence,
  MAX_CONTINUATION_WINDOW_MINUTES,
  MIN_CONTINUATION_CONFIDENCE,
  type ContinuationSignals,
} from "@/lib/documentContinuation";

// Multi-signal multi-page detection — "הזיהוי אינו יכול להסתמך רק על חלון
// זמן של שתי דקות". These tests cover the pure scoring function directly,
// independent of the DB-backed integration tests in
// processInboundAttachment.integration.test.ts.

function signals(overrides: Partial<ContinuationSignals> = {}): ContinuationSignals {
  return {
    personName: null,
    companyName: null,
    referenceNumber: null,
    pageNumberCurrent: null,
    pageNumberTotal: null,
    receivedAt: new Date("2026-01-01T10:00:00Z"),
    ...overrides,
  };
}

describe("computeContinuationConfidence", () => {
  it("returns 0 outside the hard time cutoff, regardless of other signals", () => {
    const priorTime = new Date("2026-01-01T10:00:00Z");
    const prior = signals({ referenceNumber: "123", receivedAt: priorTime });
    const candidate = signals({
      referenceNumber: "123",
      pageNumberCurrent: 2,
      pageNumberTotal: 2,
      receivedAt: new Date(priorTime.getTime() + (MAX_CONTINUATION_WINDOW_MINUTES + 1) * 60000),
    });
    expect(computeContinuationConfidence(prior, candidate)).toBe(0);
  });

  it("returns 0 when the candidate arrived before the prior document", () => {
    const prior = signals({ receivedAt: new Date("2026-01-01T10:05:00Z") });
    const candidate = signals({ receivedAt: new Date("2026-01-01T10:00:00Z") });
    expect(computeContinuationConfidence(prior, candidate)).toBe(0);
  });

  it("a bare same-type document with no corroborating signal clears the threshold within roughly the old 2-minute window, but not well beyond it", () => {
    const prior = signals({ receivedAt: new Date("2026-01-01T10:00:00Z") });
    const quick = signals({ receivedAt: new Date("2026-01-01T10:01:00Z") });
    const slow = signals({ receivedAt: new Date("2026-01-01T10:08:00Z") });

    expect(computeContinuationConfidence(prior, quick)).toBeGreaterThanOrEqual(MIN_CONTINUATION_CONFIDENCE);
    expect(computeContinuationConfidence(prior, slow)).toBeLessThan(MIN_CONTINUATION_CONFIDENCE);
  });

  it("a matching reference number allows a later-than-2-minute merge to still be trusted", () => {
    const prior = signals({ referenceNumber: "INV-9001", receivedAt: new Date("2026-01-01T10:00:00Z") });
    const candidate = signals({ referenceNumber: "INV-9001", receivedAt: new Date("2026-01-01T10:07:00Z") });
    expect(computeContinuationConfidence(prior, candidate)).toBeGreaterThanOrEqual(MIN_CONTINUATION_CONFIDENCE);
  });

  it("a mismatched reference number gets no bonus", () => {
    const prior = signals({ referenceNumber: "INV-9001", receivedAt: new Date("2026-01-01T10:00:00Z") });
    const candidate = signals({ referenceNumber: "INV-4242", receivedAt: new Date("2026-01-01T10:07:00Z") });
    expect(computeContinuationConfidence(prior, candidate)).toBeLessThan(MIN_CONTINUATION_CONFIDENCE);
  });

  it("sequential printed page numbers ('page 2 of 3' following 'page 1 of 3') allow a later merge to still be trusted", () => {
    const prior = signals({
      pageNumberCurrent: 1,
      pageNumberTotal: 3,
      receivedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const candidate = signals({
      pageNumberCurrent: 2,
      pageNumberTotal: 3,
      receivedAt: new Date("2026-01-01T10:08:00Z"),
    });
    expect(computeContinuationConfidence(prior, candidate)).toBeGreaterThanOrEqual(MIN_CONTINUATION_CONFIDENCE);
  });

  it("non-sequential page numbers (page 1 followed by page 1 again, or a mismatched total) get no bonus", () => {
    const prior = signals({ pageNumberCurrent: 1, pageNumberTotal: 3, receivedAt: new Date("2026-01-01T10:00:00Z") });
    const repeatedPage = signals({
      pageNumberCurrent: 1,
      pageNumberTotal: 3,
      receivedAt: new Date("2026-01-01T10:08:00Z"),
    });
    const differentTotal = signals({
      pageNumberCurrent: 2,
      pageNumberTotal: 5,
      receivedAt: new Date("2026-01-01T10:08:00Z"),
    });
    expect(computeContinuationConfidence(prior, repeatedPage)).toBeLessThan(MIN_CONTINUATION_CONFIDENCE);
    expect(computeContinuationConfidence(prior, differentTotal)).toBeLessThan(MIN_CONTINUATION_CONFIDENCE);
  });

  it("a matching extracted person name contributes a partial bonus", () => {
    const prior = signals({ personName: "ישראל ישראלי", receivedAt: new Date("2026-01-01T10:00:00Z") });
    const sameName = signals({ personName: "ישראל ישראלי", receivedAt: new Date("2026-01-01T10:04:00Z") });
    const differentName = signals({ personName: "דוד כהן", receivedAt: new Date("2026-01-01T10:04:00Z") });
    expect(computeContinuationConfidence(prior, sameName)).toBeGreaterThan(
      computeContinuationConfidence(prior, differentName)
    );
  });

  it("a matching company name contributes the same bonus channel as person name (max of the two)", () => {
    const prior = signals({ companyName: "חברת בדיקה בע\"מ", receivedAt: new Date("2026-01-01T10:00:00Z") });
    const sameCompany = signals({ companyName: "חברת בדיקה בע\"מ", receivedAt: new Date("2026-01-01T10:04:00Z") });
    const noCompany = signals({ receivedAt: new Date("2026-01-01T10:04:00Z") });
    expect(computeContinuationConfidence(prior, sameCompany)).toBeGreaterThan(
      computeContinuationConfidence(prior, noCompany)
    );
  });

  it("never exceeds a confidence of 1 even when every signal corroborates", () => {
    const prior = signals({
      personName: "ישראל ישראלי",
      companyName: "חברה בע\"מ",
      referenceNumber: "REF-1",
      pageNumberCurrent: 1,
      pageNumberTotal: 2,
      receivedAt: new Date("2026-01-01T10:00:00Z"),
    });
    const candidate = signals({
      personName: "ישראל ישראלי",
      companyName: "חברה בע\"מ",
      referenceNumber: "REF-1",
      pageNumberCurrent: 2,
      pageNumberTotal: 2,
      receivedAt: new Date("2026-01-01T10:00:10Z"),
    });
    expect(computeContinuationConfidence(prior, candidate)).toBeLessThanOrEqual(1);
  });
});
