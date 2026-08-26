import { resolveMessageDeliveryState } from "@/lib/messageDeliveryState";

/**
 * What a request needs from the employee, and the one thing to do about it.
 *
 * The attention area used to stack independent sentences — "לא ענה", "דורש
 * תשומת לב שלך", "שליחת הודעה נכשלה", "כדאי לבדוק את השיחה למטה" — beside a
 * button labelled "הפעלה". None of them said what to DO, and the button was
 * a raw state-machine transition (status → active) that never touches
 * WhatsApp: on a request that is already active with a failed message it
 * changes nothing while looking like the remedy.
 *
 * This resolves ONE state, and each state names its own action. The rule
 * throughout: never offer an action that cannot actually run. A button that
 * is not going to work is worse than no button, because it costs the
 * employee a click and their trust.
 */

export type RequestAttentionKind =
  | "message_failed"
  | "awaiting_client"
  | "not_connected"
  | "needs_review"
  | "paused"
  | "none";

export type AttentionActionKind = "retry_send" | "send_reminder" | "reactivate" | "open_conversation";

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
   * The first version returned a single state, so a failed send erased the
   * fact that the client had been silent for three days — two genuinely
   * different problems, and hiding one of them left the employee without
   * the business context for the action they were being asked to take.
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
  /** Delivery status of the most recent OUTBOUND message, if any. */
  lastOutboundDeliveryStatus?: string | null;
  /** True once the client has ever replied. */
  clientHasReplied: boolean;
  /** Requirements still outstanding. */
  unsatisfiedCount: number;
  /** Documents/questions sitting in the employee's queue. */
  reviewItemCount: number;
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
  /** Days since the request was opened, for the overdue wording. */
  daysOpen: number;
}

const OVERDUE_AFTER_DAYS = 3;

export function resolveRequestAttentionState(input: RequestAttentionInput): RequestAttentionState {
  const {
    status,
    lastOutboundDeliveryStatus,
    clientHasReplied,
    unsatisfiedCount,
    reviewItemCount,
    whatsappReady,
    hasConversation,
    retryCanSucceed,
    daysOpen,
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

  // ── Gather EVERY reason, independently. ─────────────────────────────
  // These are different problems and one must not erase another: a failed
  // send does not stop the client having been silent for three days, and
  // the employee needs both to understand the action they are given.
  const reasons: AttentionReason[] = [];

  const clientIsLate = unsatisfiedCount > 0 && daysOpen >= OVERDUE_AFTER_DAYS;
  if (clientIsLate) {
    reasons.push({
      title: clientHasReplied ? "הלקוח עדיין לא השלים את הבקשה" : "הלקוח לא הגיב לבקשה",
      detail: `עברו ${daysOpen} ימים והמסמכים עדיין חסרים.`,
    });
  }

  const deliveryFailed = resolveMessageDeliveryState(lastOutboundDeliveryStatus) === "failed";
  if (deliveryFailed) {
    reasons.push({
      title: "ההודעה האחרונה לא נשלחה",
      detail: "לא הצלחנו למסור את ההודעה ללקוח.",
    });
  }

  if (reviewItemCount > 0) {
    reasons.push({
      title: reviewItemCount === 1 ? "פריט אחד ממתין לבדיקה שלך" : `${reviewItemCount} פריטים ממתינים לבדיקה שלך`,
      detail: "הפריטים מופיעים למטה.",
    });
  }

  if (reasons.length === 0) return quiet;

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
  if (deliveryFailed) {
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
  if (reviewItemCount > 0) {
    return {
      kind: "needs_review",
      reasons,
      severity: "warning",
      guidance: "עברו על הפריטים למטה כדי להמשיך את הבקשה.",
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
