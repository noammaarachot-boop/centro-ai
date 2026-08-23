// The single source of truth for what "מחובר / לא מחובר / דורש טיפול"
// means for an organization's integrations.
//
// Pure — no DB access — so it is testable directly and so both the
// organizations list and a single organization's page derive the exact
// same verdict from the same inputs, instead of two lists of conditions
// drifting apart.
//
// The governing rule, and the reason this is not just a boolean column:
// "דורש טיפול" must describe a problem that is TRUE RIGHT NOW. A failure
// that has since been resolved must clear itself with no manual action —
// so every failing signal here is only honoured while it is still the
// most recent evidence about that integration.

export type ConnectionState = "connected" | "not_connected" | "needs_attention";

export interface ConnectionHealth {
  state: ConnectionState;
  /** Human-readable Hebrew, present only for "needs_attention". Never an event code. */
  reason: string | null;
}

// A one-off failure is noise (a flaky network, a client who blocked the
// number); a run of them with no success after is a real, current problem.
export const CONSECUTIVE_SEND_FAILURE_THRESHOLD = 3;

export interface WhatsAppHealthInput {
  connectedAt: Date | null;
  phoneNumberId: string | null;
  /** Result of the last explicit "בדוק וחבר", if one was ever run. */
  healthOk: boolean | null;
  healthReason: string | null;
  healthCheckedAt: Date | null;
  /**
   * Consecutive failed outbound sends at the TAIL of this organization's
   * message history — i.e. failures with no successful send after them.
   * A single later success resets this to 0, which is what makes a
   * resolved outage clear itself.
   */
  consecutiveSendFailures: number;
  /** When the most recent SUCCESSFUL send happened, if ever. */
  lastSuccessfulSendAt: Date | null;
}

export function resolveWhatsAppHealth(input: WhatsAppHealthInput): ConnectionHealth {
  if (!input.connectedAt || !input.phoneNumberId) {
    // Never connected is not a fault — it is a neutral, expected state for
    // an organization that simply hasn't been set up yet.
    return { state: "not_connected", reason: null };
  }

  if (input.consecutiveSendFailures >= CONSECUTIVE_SEND_FAILURE_THRESHOLD) {
    return {
      state: "needs_attention",
      reason: `${input.consecutiveSendFailures} שליחות WhatsApp נכשלו ברצף`,
    };
  }

  // A failed explicit check still stands only if nothing has succeeded
  // since it ran. A successful send afterwards is proof the integration
  // recovered, and outranks the older check.
  if (input.healthOk === false && input.healthCheckedAt) {
    const recoveredSince =
      input.lastSuccessfulSendAt !== null && input.lastSuccessfulSendAt > input.healthCheckedAt;
    if (!recoveredSince) {
      return {
        state: "needs_attention",
        reason: input.healthReason ?? "בדיקת החיבור מול Meta נכשלה",
      };
    }
  }

  return { state: "connected", reason: null };
}

export interface DriveHealthInput {
  connectedAt: Date | null;
  healthOk: boolean | null;
  healthReason: string | null;
  healthCheckedAt: Date | null;
}

export function resolveDriveHealth(input: DriveHealthInput): ConnectionHealth {
  if (!input.connectedAt) {
    return { state: "not_connected", reason: null };
  }

  // Drive has no passive success signal equivalent to a sent message, so
  // the last explicit check is the only evidence — and a later successful
  // check overwrites the row, which is how this clears.
  if (input.healthOk === false) {
    return {
      state: "needs_attention",
      reason: input.healthReason ?? "לא ניתן לגשת לתיקיית Google Drive",
    };
  }

  return { state: "connected", reason: null };
}

const STATE_LABELS: Record<ConnectionState, string> = {
  connected: "מחובר",
  not_connected: "לא מחובר",
  needs_attention: "דורש טיפול",
};

// "WhatsApp מחובר" / "Drive לא מחובר" / "WhatsApp — דורש טיפול: ...".
// One place builds this sentence, so the wording can never differ between
// the list and the detail page.
export function describeConnection(service: string, health: ConnectionHealth): string {
  const label = STATE_LABELS[health.state];
  if (health.state === "needs_attention" && health.reason) {
    return `${service} — ${label}: ${health.reason}`;
  }
  return `${service} ${label}`;
}

export function connectionTone(state: ConnectionState): "success" | "neutral" | "danger" {
  if (state === "connected") return "success";
  if (state === "needs_attention") return "danger";
  return "neutral";
}
