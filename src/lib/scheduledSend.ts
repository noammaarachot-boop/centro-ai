import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests } from "@/db/schema";
import { startConversation } from "@/lib/conversationOrchestration";
import { recordAuditEvent } from "@/lib/audit";

/**
 * Product Evolution M7 — Workflow B's "Send Request: Now or Schedule."
 *
 * A Template send never delivers by writing messages directly; it always
 * goes through this one function, used two ways:
 *   - Synchronously, right when "Send Now" is submitted (the request's
 *     `scheduledAt` is set to the current moment, "due immediately") — so
 *     the employee gets real feedback instead of waiting for a cron tick.
 *   - By src/lib/scheduler.ts's cron tick, for requests scheduled for a
 *     future date/time, once that time arrives.
 *
 * Both paths are the same one delivery attempt: reuses
 * conversationOrchestration.ts's startConversation exactly as the
 * recurring workflow's own "send initial request" action does, so
 * BR-18.1's business-hours gate applies identically. If delivery isn't
 * possible right now (outside business hours), the request is left
 * exactly as it was — still `draft`, `scheduledAt` untouched — for the
 * next cron tick to retry, never silently marked as sent.
 */
export async function attemptScheduledDelivery(
  organizationId: string,
  collectionRequestId: string,
  clientId: string
): Promise<boolean> {
  const { sent } = await startConversation(organizationId, collectionRequestId, clientId);
  if (!sent) return false;

  const db = await getDb();
  await db
    .update(collectionRequests)
    .set({ status: "active", scheduledAt: null, updatedAt: new Date() })
    .where(eq(collectionRequests.id, collectionRequestId));

  await recordAuditEvent({
    organizationId,
    eventType: "collection_request.scheduled_send_delivered",
    description: "בקשת האיסוף נשלחה ללקוח",
    actorType: "system",
    clientId,
    collectionRequestId,
  });

  return true;
}
