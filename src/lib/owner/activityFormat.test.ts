import { describe, expect, it } from "vitest";
import {
  AGGREGATION_WINDOW_MS,
  aggregateActivity,
  formatAggregatedTitle,
  humanizeEventType,
  isProblemEvent,
  type RawActivityEvent,
} from "./activityFormat";

const base = new Date("2026-08-23T14:38:00Z");

function event(overrides: Partial<RawActivityEvent> = {}): RawActivityEvent {
  return {
    id: crypto.randomUUID(),
    occurredAt: base,
    eventType: "whatsapp.send_failed",
    description: "שליחה נכשלה",
    source: "organization",
    organizationName: "נועם מערכות",
    ...overrides,
  };
}

describe("humanizeEventType", () => {
  it("replaces the internal event code with a real sentence", () => {
    expect(humanizeEventType("whatsapp.send_failed", "raw")).toBe("שליחת הודעת WhatsApp נכשלה");
    expect(humanizeEventType("collection_request.cancelled", "raw")).toBe("בקשת איסוף בוטלה");
  });

  it("falls back to the event's own Hebrew description rather than showing a bare code", () => {
    expect(humanizeEventType("something.brand_new", "המסמך נשמר בהצלחה")).toBe("המסמך נשמר בהצלחה");
  });

  it("only shows the raw code when there is genuinely nothing else to show", () => {
    expect(humanizeEventType("something.brand_new", "")).toBe("something.brand_new");
  });
});

describe("isProblemEvent", () => {
  it("flags failures and escalations as problems", () => {
    expect(isProblemEvent("whatsapp.send_failed")).toBe(true);
    expect(isProblemEvent("collection_request.escalated")).toBe(true);
    expect(isProblemEvent("owner.organization_suspended")).toBe(true);
  });

  it("leaves routine events alone", () => {
    expect(isProblemEvent("document.uploaded")).toBe(false);
    expect(isProblemEvent("integration.whatsapp_connected")).toBe(false);
  });
});

describe("aggregateActivity", () => {
  it("collapses a burst of identical failures into ONE row with a count and a time range", () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      event({ occurredAt: new Date(base.getTime() - i * 60_000) })
    );

    const rows = aggregateActivity(events);

    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(8);
    expect(rows[0].occurredAt).toEqual(base); // newest
    expect(rows[0].firstOccurredAt).toEqual(new Date(base.getTime() - 7 * 60_000)); // oldest
    expect(rows[0].raw).toHaveLength(8); // nothing thrown away
    expect(formatAggregatedTitle(rows[0])).toBe("שליחת הודעת WhatsApp נכשלה 8 פעמים");
  });

  it("keeps a single event as a single row, with no count suffix", () => {
    const rows = aggregateActivity([event()]);
    expect(rows[0].count).toBe(1);
    expect(formatAggregatedTitle(rows[0])).toBe("שליחת הודעת WhatsApp נכשלה");
  });

  it("never merges different organizations, even for the same event type", () => {
    const rows = aggregateActivity([
      event({ organizationName: "נועם מערכות" }),
      event({ organizationName: "רז שלום", occurredAt: new Date(base.getTime() - 60_000) }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("never merges different event types", () => {
    const rows = aggregateActivity([
      event({ eventType: "whatsapp.send_failed" }),
      event({ eventType: "document.uploaded", occurredAt: new Date(base.getTime() - 60_000) }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("splits a run when an unrelated event happened in between — two separate bursts, not one", () => {
    const rows = aggregateActivity([
      event({ occurredAt: base }),
      event({ eventType: "document.uploaded", occurredAt: new Date(base.getTime() - 60_000) }),
      event({ occurredAt: new Date(base.getTime() - 120_000) }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it("does not merge across the aggregation window — a burst today and one yesterday stay separate", () => {
    const rows = aggregateActivity([
      event({ occurredAt: base }),
      event({ occurredAt: new Date(base.getTime() - AGGREGATION_WINDOW_MS - 1000) }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("marks a failure burst as a problem so it can be styled distinctly", () => {
    const rows = aggregateActivity([event(), event({ occurredAt: new Date(base.getTime() - 1000) })]);
    expect(rows[0].severity).toBe("problem");
  });

  it("returns nothing for no events", () => {
    expect(aggregateActivity([])).toEqual([]);
  });
});
