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

export interface RequestAttentionState {
  kind: RequestAttentionKind;
  severity: "danger" | "warning" | "info" | "none";
  /** One sentence: what happened. */
  title: string;
  /** One sentence: what to do now, or why nothing can be done. */
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
    daysOpen,
  } = input;

  const openConversation: AttentionAction | null = hasConversation
    ? { kind: "open_conversation", label: "פתיחת השיחה" }
    : null;

  // Terminal states need nothing.
  if (status === "completed" || status === "cancelled") {
    return { kind: "none", severity: "none", title: "", guidance: "", primaryAction: null, secondaryAction: null };
  }

  // A paused/draft request is not failing — it simply has not started.
  // "הפעל את הבקשה מחדש" is honest here in a way it never was elsewhere,
  // because starting it IS the missing step.
  if (status === "draft") {
    return {
      kind: "paused",
      severity: "info",
      title: "הבקשה עדיין לא נשלחה ללקוח",
      guidance: "היא שמורה כטיוטה. הפעלה תשלח את הבקשה ותתחיל את מחזור התזכורות.",
      primaryAction: { kind: "reactivate", label: "הפעלת הבקשה ושליחה ללקוח" },
      secondaryAction: null,
    };
  }

  // The organization cannot send at all. Offering a retry here would fail
  // for the same reason every time, so it is not offered.
  if (!whatsappReady) {
    return {
      kind: "not_connected",
      severity: "danger",
      title: "WhatsApp אינו מחובר",
      guidance: "אי אפשר לשלוח ללקוח עד שהחיבור ל-WhatsApp יושלם בהגדרות.",
      primaryAction: null,
      secondaryAction: openConversation,
    };
  }

  // The last thing sent never reached the client. This outranks "the
  // client has not replied", because the client had nothing to reply to.
  const lastState = resolveMessageDeliveryState(lastOutboundDeliveryStatus);
  if (lastState === "failed") {
    return {
      kind: "message_failed",
      severity: "danger",
      title: "ההודעה האחרונה ללקוח לא נשלחה",
      guidance: "הבקשה עדיין פתוחה, אבל הלקוח לא קיבל את ההודעה. אפשר לנסות לשלוח אותה שוב.",
      primaryAction: { kind: "retry_send", label: "שליחה חוזרת" },
      secondaryAction: openConversation,
    };
  }

  // Something is waiting in the employee's own queue — a document to
  // approve, a question to answer. Sending anything else first would be
  // noise.
  if (reviewItemCount > 0) {
    return {
      kind: "needs_review",
      severity: "warning",
      title: reviewItemCount === 1 ? "פריט אחד ממתין לבדיקה שלך" : `${reviewItemCount} פריטים ממתינים לבדיקה שלך`,
      guidance: "עברו על הפריטים למטה כדי להמשיך את הבקשה.",
      primaryAction: null,
      secondaryAction: openConversation,
    };
  }

  // Delivered, and the client simply has not finished. A reminder is the
  // right action — and it is the only state where it is.
  if (unsatisfiedCount > 0 && daysOpen >= OVERDUE_AFTER_DAYS) {
    return {
      kind: "awaiting_client",
      severity: "warning",
      title: clientHasReplied
        ? `הלקוח טרם השלים את המסמכים — ${daysOpen} ימים`
        : `הלקוח לא הגיב — ${daysOpen} ימים`,
      guidance: "ההודעה נמסרה. אפשר לשלוח תזכורת עכשיו מבלי להמתין למחזור הבא.",
      primaryAction: { kind: "send_reminder", label: "שליחת תזכורת עכשיו" },
      secondaryAction: openConversation,
    };
  }

  return { kind: "none", severity: "none", title: "", guidance: "", primaryAction: null, secondaryAction: null };
}
