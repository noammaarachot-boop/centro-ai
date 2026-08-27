import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, conversations, messages } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { ensureConversation, sendOutboundMessage } from "@/lib/conversationOrchestration";
import { buildReminderSend } from "@/lib/reminderContent";

/**
 * One reminder, for one collection request, sent now.
 *
 * Extracted from the "שליחת תזכורת עכשיו" server action so the send itself
 * has exactly ONE implementation with two authenticated entry points: the
 * employee action (which authenticates a session and scopes to that
 * employee's organization), and the CRON_SECRET-protected operational
 * trigger used to verify a live send end to end. Duplicating this logic for
 * the second caller is precisely how the two template universes that caused
 * the original incident came to exist.
 *
 * This function performs NO authorization of its own — every caller must
 * establish who is asking and pass an organizationId it has already proven
 * the caller owns. The organizationId given here is what scopes the request
 * lookup below, so a request belonging to another tenant is simply not
 * found rather than sent.
 */
export interface ManualReminderResult {
  ok: boolean;
  /** Meta's message id, only ever set when the provider accepted the send. */
  whatsappMessageId?: string | null;
  deliveryStatus?: string;
  failureReason?: string;
  error?: string;
}

export async function sendManualReminder(
  organizationId: string,
  collectionRequestId: string,
  actor: { actorType: "employee" | "system"; actorUserId?: string }
): Promise<ManualReminderResult> {
  const db = await getDb();

  // Scoped by organizationId: a request that belongs to a different tenant
  // is not visible here at all.
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!current || current.organizationId !== organizationId) {
    return { ok: false, error: "הבקשה לא נמצאה עבור הארגון הזה." };
  }

  const conversation = await ensureConversation(organizationId, collectionRequestId, current.clientId);
  const [client] = await db.select().from(clients).where(eq(clients.id, current.clientId)).limit(1);

  const reminderSend = await buildReminderSend(
    conversation.id,
    collectionRequestId,
    client?.name ?? "",
    organizationId
  );
  if (reminderSend.unavailable) {
    return { ok: false, error: reminderSend.unavailable.reason };
  }

  // Bucketed to the minute: a double-click cannot produce two messages,
  // while a genuine second attempt a minute later still can. A previous
  // attempt that failed BEFORE Meta returned a message id leaves no
  // successful row, so a controlled retry remains possible.
  const minuteBucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const idempotencyKey = `manual-reminder:${conversation.id}:${minuteBucket}`;
  const { sent, deliveryStatus, failureReason } = await sendOutboundMessage(
    organizationId,
    conversation.id,
    reminderSend.body,
    "ai",
    "manual",
    reminderSend.templateSend,
    reminderSend.allowFreeform,
    undefined,
    idempotencyKey
  );

  if (deliveryStatus === "duplicate_suppressed") {
    return { ok: false, deliveryStatus, error: "תזכורת כבר נשלחה ברגע זה." };
  }
  if (!sent) {
    return { ok: false, deliveryStatus, failureReason, error: "שליחת התזכורת נכשלה." };
  }

  // The cycle restarts from this send, so the automatic reminder does not
  // arrive moments later on top of it.
  await db
    .update(conversations)
    .set({ reminderAnchorAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  // Read the provider's id back off the row the send just wrote, rather
  // than widening sendOutboundMessage's return shape for one caller. The
  // idempotency key identifies exactly this send.
  const [row] = await db
    .select({ whatsappMessageId: messages.whatsappMessageId })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);

  await recordAuditEvent({
    organizationId,
    eventType: "scheduler.reminder_sent",
    description:
      actor.actorType === "employee"
        ? "תזכורת נשלחה ידנית מתוך מסך הבקשה"
        : "תזכורת נשלחה ידנית דרך טריגר תפעולי מאובטח",
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    collectionRequestId,
  });

  return { ok: true, whatsappMessageId: row?.whatsappMessageId ?? null, deliveryStatus };
}
