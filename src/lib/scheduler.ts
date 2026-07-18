import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, conversations, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import {
  evaluateAndPrompt,
  sendOutboundMessage,
} from "@/lib/conversationOrchestration";

const REMINDER_MESSAGE =
  "תזכורת: עדיין ממתינים לתשובתכם - 'סיימתי' או 'יש עוד מסמכים'?";

/**
 * The real automatic trigger Ch.5/Ch.16 describe — "after N minutes of
 * inactivity" and "send another confirmation request the following day"
 * — as opposed to M8's manually-clicked stand-ins for the same functions
 * (evaluateAndPrompt itself is unchanged; this is what's supposed to call
 * it on a timer). Meant to be invoked by an external scheduler hitting
 * POST /api/cron/tick (see that route for the auth check) since there's
 * no in-process cron in a serverless-style deployment; a "run now" button
 * on /settings covers the pilot until one is wired up.
 */
export async function runScheduledTasks(): Promise<{
  evaluated: number;
  reminded: number;
}> {
  const db = await getDb();
  const allOrganizations = await db.select().from(organizations);

  let evaluated = 0;
  let reminded = 0;

  for (const organization of allOrganizations) {
    const inactivityCutoff = new Date(
      Date.now() - organization.inactivityTimeoutMinutes * 60 * 1000
    );
    const reminderCutoff = new Date(
      Date.now() - organization.reminderIntervalDays * 24 * 60 * 60 * 1000
    );

    // Ch.16 FR-16.4: after inactivity, evaluate whether known requirements
    // are satisfied. Only conversations still "open" on an active request
    // (BR-6.3: cancelled/completed requests never get automated messages).
    const idleOpenConversations = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
      })
      .from(conversations)
      .innerJoin(
        collectionRequests,
        eq(conversations.collectionRequestId, collectionRequests.id)
      )
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          eq(conversations.status, "open"),
          eq(collectionRequests.status, "active"),
          lt(conversations.updatedAt, inactivityCutoff)
        )
      );

    for (const conversation of idleOpenConversations) {
      const { prompted } = await evaluateAndPrompt(
        organization.id,
        conversation.collectionRequestId,
        conversation.id
      );
      evaluated += 1;
      if (prompted) {
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "scheduler.evaluation_prompted",
          description: "המתזמן זיהה חוסר פעילות והפעיל הערכה אוטומטית",
          actorType: "system",
        });
      }
    }

    // Ch.16 FR-16.11 / Ch.18 Reminder Interval: nudge clients who haven't
    // replied Finished/More Documents after the configured interval.
    const staleWaitingConversations = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
      })
      .from(conversations)
      .innerJoin(
        collectionRequests,
        eq(conversations.collectionRequestId, collectionRequests.id)
      )
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          eq(conversations.status, "waiting_for_client"),
          eq(collectionRequests.status, "waiting_for_client"),
          lt(conversations.updatedAt, reminderCutoff)
        )
      );

    for (const conversation of staleWaitingConversations) {
      const { sent } = await sendOutboundMessage(
        organization.id,
        conversation.id,
        REMINDER_MESSAGE,
        "ai"
      );
      if (sent) {
        reminded += 1;
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "scheduler.reminder_sent",
          description: "תזכורת אוטומטית נשלחה עקב חוסר תגובה",
          actorType: "system",
        });
      }
    }
  }

  return { evaluated, reminded };
}
