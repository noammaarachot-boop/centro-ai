import type { ReviewReason } from "@/lib/data/dashboardReadModel";

/**
 * WHICH action a request's outstanding attention calls for.
 *
 * This file used to answer two questions, and the second one was the bug. It
 * decided *whether* a request needed attention — measuring the client's
 * silence and inspecting the last message's delivery itself — and then which
 * button to offer. That first answer existed nowhere else in the system, so
 * the request card could say "דורש טיפול" while the dashboard, deriving
 * attention from getItemsNeedingReview, called the same request "בתהליך".
 *
 * Detection now happens once, in getItemsNeedingReview, for every surface.
 * What is left here is the part that was always unique to this screen: given
 * the reasons, name the one action that actually moves the request forward.
 *
 * The rule that survives unchanged: never offer an action that cannot run. A
 * button that is not going to work is worse than no button, because it costs
 * the employee a click and their trust.
 */

export type RequestAttentionKind =
  | "message_failed"
  | "awaiting_client"
  | "awaiting_reply"
  | "not_connected"
  | "needs_review"
  | "paused"
  | "none";

export type AttentionActionKind = "retry_send" | "send_reminder" | "reactivate" | "open_conversation";

/**
 * How long after a reminder the panel reports "waiting for a reply" instead
 * of offering to send another one. Long enough that the client has a real
 * chance to answer before the employee is invited to nudge again.
 */
export const REMINDER_QUIET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AttentionAction {
  kind: AttentionActionKind;
  label: string;
}

export interface AttentionReason {
  /** One sentence: what is true. */
  title: string;
  /** One short clause: why it matters. Kept plain — no codes, no state names. */
  detail: string;
}

export interface RequestAttentionState {
  kind: RequestAttentionKind;
  /**
   * EVERY reason this request needs attention, not just the one the CTA
   * addresses.
   *
   * A failed send does not stop the client having been silent for three days
   * — two genuinely different problems, and hiding one of them leaves the
   * employee without the business context for the action they are given.
   * `kind` still names the PRIMARY reason, which is what selects the CTA.
   */
  reasons: AttentionReason[];
  severity: "danger" | "warning" | "info" | "none";
  /**
   * One sentence: what to do now, or why nothing can be done.
   *
   * There is deliberately no single summary `title` on the state. One used
   * to exist and the panel stopped rendering it, which left tests asserting
   * on wording no user could ever see. The reasons list IS the summary.
   */
  guidance: string;
  primaryAction: AttentionAction | null;
  secondaryAction: AttentionAction | null;
}

export interface RequestAttentionInput {
  status: string;
  /**
   * This request's open attention, from getItemsNeedingReview — already
   * deduplicated, already filtered by what an employee marked as handled,
   * already scoped to the organization. This screen does not re-derive it.
   */
  reasons: ReviewReason[];
  /** Whether this organization can send at all right now. */
  whatsappReady: boolean;
  /** Whether a conversation exists to open. */
  hasConversation: boolean;
  /**
   * Whether a resend has any chance of reaching the client.
   *
   * WhatsApp only accepts free text inside the 24-hour window that a client
   * message opens. A failed free-text send to a client whose window is shut
   * will be refused identically every time, so offering "שליחה חוזרת" there
   * is a button that cannot work. Template sends are not window-bound and
   * can always be retried.
   */
  retryCanSucceed: boolean;
  /**
   * When a reminder was last actually delivered to the provider for this
   * request, or null if never.
   *
   * Without it the panel kept offering "שליחת תזכורת עכשיו" immediately
   * after a reminder had just gone out — the request looked untouched by the
   * employee's own action.
   */
  lastReminderSentAt?: Date | string | null;
  /** True once the client has replied SINCE that reminder. */
  clientRepliedSinceReminder?: boolean;
  /** Injected so the window is testable and render stays pure. */
  now?: number;
}

/** How each centrally-derived reason reads on this screen. */
function describeReason(reason: ReviewReason): AttentionReason {
  switch (reason.kind) {
    case "client_overdue":
      return { title: "הלקוח לא השלים את הבקשה", detail: `${reason.detail}.` };
    case "message_failed":
      return { title: "ההודעה האחרונה לא נשלחה", detail: "לא הצלחנו למסור את ההודעה ללקוח." };
    case "escalated":
      return {
        title: "הבקשה הועברה לטיפול ידני",
        detail: reason.detail || "האוטומציה עצרה וממתינה להחלטה שלך.",
      };
    case "document_needs_review":
      return { title: "מסמך ממתין לבדיקה שלך", detail: `"${reason.detail}" מופיע למטה.` };
    case "employee_question":
      return { title: "הלקוח שאל שאלה", detail: `"${reason.detail}"` };
    case "reported_missing":
      return { title: "הלקוח דיווח שמסמך חסר", detail: `"${reason.detail}"` };
  }
}

export function resolveRequestAttentionState(input: RequestAttentionInput): RequestAttentionState {
  const {
    status,
    reasons: openReasons,
    whatsappReady,
    hasConversation,
    retryCanSucceed,
    lastReminderSentAt,
    clientRepliedSinceReminder,
    now = Date.now(),
  } = input;

  const quiet: RequestAttentionState = {
    kind: "none",
    reasons: [],
    severity: "none",
    guidance: "",
    primaryAction: null,
    secondaryAction: null,
  };

  // A finished request needs nothing, whatever else is true about it.
  if (status === "completed" || status === "cancelled") return quiet;

  const openConversation: AttentionAction | null = hasConversation
    ? { kind: "open_conversation", label: "פתיחת השיחה" }
    : null;

  // Not started yet: the missing step is starting it, and nothing else on
  // this list can apply.
  if (status === "draft") {
    return {
      kind: "paused",
      reasons: [{ title: "הבקשה עדיין לא נשלחה ללקוח", detail: "היא שמורה כטיוטה." }],
      severity: "info",
      guidance: "הפעלה תשלח את הבקשה ללקוח ותתחיל את מחזור התזכורות.",
      primaryAction: { kind: "reactivate", label: "הפעלת הבקשה ושליחה ללקוח" },
      secondaryAction: null,
    };
  }

  if (openReasons.length === 0) return quiet;

  const reasons = openReasons.map(describeReason);
  const has = (kind: ReviewReason["kind"]) => openReasons.some((reason) => reason.kind === kind);

  // ── Pick the ONE action, in order of what blocks what. ───────────────

  // Nothing can be sent at all. An endless "try again" here would fail for
  // the same reason every time, so it is not offered — the fix is elsewhere.
  if (!whatsappReady) {
    return {
      kind: "not_connected",
      reasons,
      severity: "danger",
      guidance: "החיבור ל-WhatsApp אינו פעיל. יש להשלים אותו בהגדרות כדי להמשיך.",
      primaryAction: null,
      secondaryAction: openConversation,
    };
  }

  // Delivery is the blocker: whatever the business situation, the client
  // cannot act on a message that never arrived, so getting it there comes
  // first — while the business reason stays visible above it.
  if (has("message_failed")) {
    return {
      kind: "message_failed",
      reasons,
      severity: "danger",
      guidance: retryCanSucceed
        ? "אפשר לנסות לשלוח שוב."
        : "הלקוח עדיין לא פתח שיחה, ולכן אפשר לפנות אליו רק בהודעה מאושרת. שליחת תזכורת תעשה זאת.",
      // No endless retry: when the send was refused for a reason another
      // identical attempt cannot change, a different action is offered.
      primaryAction: retryCanSucceed
        ? { kind: "retry_send", label: "שליחה חוזרת" }
        : { kind: "send_reminder", label: "שליחת תזכורת עכשיו" },
      secondaryAction: openConversation,
    };
  }

  // The employee's own queue comes before nudging the client again —
  // sending another message on top of unreviewed work is noise.
  if (has("document_needs_review") || has("employee_question") || has("reported_missing")) {
    return {
      kind: "needs_review",
      reasons,
      severity: "warning",
      guidance: "עברו על הפריטים למטה כדי להמשיך את הבקשה.",
      primaryAction: null,
      secondaryAction: openConversation,
    };
  }

  // A reminder has just gone out and the client has not answered it yet.
  //
  // The request is still genuinely overdue, so it stays in "דורש טיפול" —
  // but the thing that needs attention has changed. Offering "send a
  // reminder" again here is both wrong (one was just sent) and an invitation
  // to message the client twice for the same thing.
  const remindedAt = lastReminderSentAt ? new Date(lastReminderSentAt).getTime() : null;
  const remindedRecently =
    remindedAt !== null && Number.isFinite(remindedAt) && now - remindedAt < REMINDER_QUIET_WINDOW_MS;
  if (remindedRecently && !clientRepliedSinceReminder) {
    return {
      kind: "awaiting_reply",
      reasons,
      severity: "warning",
      guidance: "תזכורת נשלחה — ממתינים לתגובת הלקוח.",
      // Deliberately no send action: the reminder is out, and the next
      // automatic one is already scheduled.
      primaryAction: null,
      secondaryAction: openConversation,
    };
  }

  // Delivered, and the client simply has not finished. A reminder is the
  // right action, and this is the only state where it is.
  return {
    kind: "awaiting_client",
    reasons,
    severity: "warning",
    guidance: "ההודעה נמסרה. אפשר לשלוח תזכורת עכשיו מבלי להמתין למחזור הבא.",
    primaryAction: { kind: "send_reminder", label: "שליחת תזכורת עכשיו" },
    secondaryAction: openConversation,
  };
}
