/**
 * The one place that decides what a message's delivery status MEANS.
 *
 * Every screen used to infer this for itself, and they disagreed. The
 * conversation thread painted every outbound row as a delivered WhatsApp
 * bubble, the request header counted every row as a message, and
 * attemptScheduledDelivery wrote "בקשת האיסוף נשלחה ללקוח" — all from rows
 * that WhatsApp had refused. Production holds 958 such rows; three requests
 * were shown as sent to clients who received nothing at all.
 *
 * `messages.deliveryStatus` is the raw provider-facing value; this maps it
 * to the product's own lifecycle so the mapping exists exactly once:
 *
 *   pending    — row written, the provider has not answered yet
 *   sent       — the provider ACCEPTED it (this is the first honest "sent")
 *   delivered  — the provider confirmed it reached the device
 *   read       — the client opened it
 *   failed     — the provider refused it, or it never left Centro
 *
 * "reached the client" starts at `sent` and nowhere earlier. A row on its
 * own proves only that Centro tried.
 */

export type MessageDeliveryState = "pending" | "sent" | "delivered" | "read" | "failed";

/** Provider-refused/never-left-Centro statuses, all of which mean failed. */
const FAILED_STATUSES = new Set([
  "failed",
  "stuck",
  "not_connected",
  "no_template",
  "invalid_phone",
  "blocked",
]);

export function resolveMessageDeliveryState(
  deliveryStatus: string | null | undefined
): MessageDeliveryState {
  if (!deliveryStatus) return "pending";
  if (FAILED_STATUSES.has(deliveryStatus)) return "failed";
  if (deliveryStatus === "read") return "read";
  if (deliveryStatus === "delivered") return "delivered";
  if (deliveryStatus === "sent") return "sent";
  // An unrecognized status is NOT optimistically treated as delivered —
  // that assumption is what produced the phantom messages in the first
  // place. Unknown means "we cannot claim it arrived".
  return "pending";
}

/**
 * Did this outbound message actually reach the client's WhatsApp?
 *
 * Inbound messages are, by definition, already with the client.
 */
export function hasReachedClient(message: {
  direction: string;
  deliveryStatus?: string | null;
}): boolean {
  if (message.direction === "inbound") return true;
  const state = resolveMessageDeliveryState(message.deliveryStatus);
  return state === "sent" || state === "delivered" || state === "read";
}

/**
 * What the office user is told about one outbound message.
 *
 * Deliberately no provider detail — the failure reason lives in audit_logs
 * for debugging, not on the client's conversation screen.
 */
export const DELIVERY_STATE_LABEL: Record<MessageDeliveryState, string> = {
  pending: "ממתינה לשליחה",
  // "sent" is exactly one fact: Meta accepted the message and returned a
  // message id. It is NOT proof the client received anything — that only
  // arrives as a delivery status webhook. Labelling it plain "נשלחה" was
  // read as "it got there", so a message Meta accepted and never delivered
  // looked like a success with no way to tell the difference.
  sent: "נשלחה — טרם אושרה מסירה",
  delivered: "נמסרה",
  read: "נקראה",
  failed: "לא נשלחה",
};

/**
 * Messages that count as a real conversation with the client.
 *
 * The request screen offered "פתיחת השיחה המלאה (114 הודעות)" for a
 * conversation in which 114 out of 114 rows had been refused by WhatsApp —
 * the client had never received one of them. A counter that includes failed
 * attempts is not counting a conversation.
 */
export function countRealConversationMessages(
  list: Array<{ direction: string; deliveryStatus?: string | null }>
): number {
  return list.filter(hasReachedClient).length;
}
