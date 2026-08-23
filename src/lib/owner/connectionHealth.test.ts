import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_SEND_FAILURE_THRESHOLD,
  connectionTone,
  describeConnection,
  resolveDriveHealth,
  resolveWhatsAppHealth,
} from "./connectionHealth";

// The governing requirement: "דורש טיפול" must mean a problem that is true
// RIGHT NOW. A resolved historical failure must never keep an organization
// red, and a one-off blip must never be treated as an outage.

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-08-23T12:00:00Z");
const earlier = new Date(now.getTime() - 3 * HOUR);
const later = new Date(now.getTime() - 1 * HOUR);

function whatsapp(overrides: Partial<Parameters<typeof resolveWhatsAppHealth>[0]> = {}) {
  return resolveWhatsAppHealth({
    connectedAt: new Date("2026-08-01T00:00:00Z"),
    phoneNumberId: "phone-1",
    healthOk: null,
    healthReason: null,
    healthCheckedAt: null,
    consecutiveSendFailures: 0,
    lastSuccessfulSendAt: null,
    ...overrides,
  });
}

describe("resolveWhatsAppHealth", () => {
  it("never connected is neutral, not a fault", () => {
    expect(whatsapp({ connectedAt: null, phoneNumberId: null })).toEqual({
      state: "not_connected",
      reason: null,
    });
  });

  it("connected with nothing wrong is simply connected, with no reason to show", () => {
    expect(whatsapp()).toEqual({ state: "connected", reason: null });
  });

  it("a one-off send failure is NOT an outage — below the threshold stays connected", () => {
    expect(whatsapp({ consecutiveSendFailures: 1 }).state).toBe("connected");
    expect(whatsapp({ consecutiveSendFailures: CONSECUTIVE_SEND_FAILURE_THRESHOLD - 1 }).state).toBe(
      "connected"
    );
  });

  it("repeated consecutive failures are a real, current problem — with a human reason", () => {
    const health = whatsapp({ consecutiveSendFailures: 8 });
    expect(health.state).toBe("needs_attention");
    expect(health.reason).toBe("8 שליחות WhatsApp נכשלו ברצף");
    // Never an event code.
    expect(health.reason).not.toContain("whatsapp.");
    expect(health.reason).not.toContain("_failed");
  });

  it("SELF-HEALING: a successful send resets the run, so a past outage clears itself", () => {
    // The count is the tail of consecutive failures; one success resets it
    // to 0 at the query level, and that alone returns the org to healthy.
    expect(whatsapp({ consecutiveSendFailures: 0, lastSuccessfulSendAt: later }).state).toBe(
      "connected"
    );
  });

  it("a failed explicit check marks it as needing attention, quoting the real reason", () => {
    const health = whatsapp({
      healthOk: false,
      healthReason: "הטוקן שהוזן אינו תקף",
      healthCheckedAt: earlier,
    });
    expect(health.state).toBe("needs_attention");
    expect(health.reason).toBe("הטוקן שהוזן אינו תקף");
  });

  it("SELF-HEALING: a successful send AFTER a failed check outranks it — the integration demonstrably recovered", () => {
    const health = whatsapp({
      healthOk: false,
      healthReason: "הטוקן שהוזן אינו תקף",
      healthCheckedAt: earlier,
      lastSuccessfulSendAt: later, // later than the failed check
    });
    expect(health.state).toBe("connected");
    expect(health.reason).toBeNull();
  });

  it("a success BEFORE the failed check does not clear it — that is older evidence, not newer", () => {
    const health = whatsapp({
      healthOk: false,
      healthReason: "הטוקן שהוזן אינו תקף",
      healthCheckedAt: later,
      lastSuccessfulSendAt: earlier, // older than the failed check
    });
    expect(health.state).toBe("needs_attention");
  });

  it("SELF-HEALING: a later successful check overwrites the stored failure entirely", () => {
    const health = whatsapp({ healthOk: true, healthReason: null, healthCheckedAt: later });
    expect(health.state).toBe("connected");
  });
});

describe("resolveDriveHealth", () => {
  it("never connected is neutral", () => {
    expect(resolveDriveHealth({ connectedAt: null, healthOk: null, healthReason: null, healthCheckedAt: null })).toEqual(
      { state: "not_connected", reason: null }
    );
  });

  it("connected and never checked is treated as connected, not as a problem", () => {
    const health = resolveDriveHealth({
      connectedAt: earlier,
      healthOk: null,
      healthReason: null,
      healthCheckedAt: null,
    });
    expect(health.state).toBe("connected");
  });

  it("a failed check surfaces as needing attention, with the real reason", () => {
    const health = resolveDriveHealth({
      connectedAt: earlier,
      healthOk: false,
      healthReason: "תיקיית היעד נמחקה או שאין אליה גישה",
      healthCheckedAt: later,
    });
    expect(health.state).toBe("needs_attention");
    expect(health.reason).toBe("תיקיית היעד נמחקה או שאין אליה גישה");
  });

  it("SELF-HEALING: re-checking successfully returns it to connected", () => {
    const health = resolveDriveHealth({
      connectedAt: earlier,
      healthOk: true,
      healthReason: null,
      healthCheckedAt: later,
    });
    expect(health.state).toBe("connected");
    expect(health.reason).toBeNull();
  });
});

describe("describeConnection / connectionTone", () => {
  it("always explains a needs_attention state — never a bare red label", () => {
    expect(describeConnection("WhatsApp", { state: "needs_attention", reason: "הטוקן פג" })).toBe(
      "WhatsApp — דורש טיפול: הטוקן פג"
    );
  });

  it("reads plainly for the ordinary states", () => {
    expect(describeConnection("WhatsApp", { state: "connected", reason: null })).toBe("WhatsApp מחובר");
    expect(describeConnection("Google Drive", { state: "not_connected", reason: null })).toBe(
      "Google Drive לא מחובר"
    );
  });

  it("maps colour so that 'not connected' is neutral, never alarming", () => {
    expect(connectionTone("connected")).toBe("success");
    expect(connectionTone("not_connected")).toBe("neutral");
    expect(connectionTone("needs_attention")).toBe("danger");
  });
});
