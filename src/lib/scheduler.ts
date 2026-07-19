import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, conversations, organizations, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { resolveScheduleConfig } from "@/lib/businessHours";
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
 *
 * `organizationId` scopes the run to one organization — required for the
 * /settings button (an employee must only ever be able to trigger their
 * own org's scheduled tasks, never every org's). Omitted only by the
 * cron endpoint, which legitimately processes every organization in one
 * tick.
 *
 * Epic 3: cutoffs are no longer one shared value per organization — each
 * conversation's Collection Request may belong to a Business Type (i.e. a
 * Service) with its own reminder/inactivity overrides
 * (resolveScheduleConfig, src/lib/businessHours.ts), so both queries below
 * fetch candidates without a SQL cutoff and resolve+filter per row in JS
 * instead. A conversation whose service has no overrides resolves to
 * exactly the organization's default, so this is behaviorally identical
 * to before for every pre-Epic-3 service.
 */
export async function runScheduledTasks(organizationId?: string): Promise<{
  evaluated: number;
  reminded: number;
}> {
  const db = await getDb();
  const allOrganizations = organizationId
    ? await db.select().from(organizations).where(eq(organizations.id, organizationId))
    : await db.select().from(organizations);

  let evaluated = 0;
  let reminded = 0;

  for (const organization of allOrganizations) {
    // Ch.16 FR-16.4: after inactivity, evaluate whether known requirements
    // are satisfied. Only conversations still "open" on an active request
    // (BR-6.3: cancelled/completed requests never get automated messages).
    const idleOpenConversations = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
        updatedAt: conversations.updatedAt,
        service: services,
      })
      .from(conversations)
      .innerJoin(
        collectionRequests,
        eq(conversations.collectionRequestId, collectionRequests.id)
      )
      .innerJoin(services, eq(collectionRequests.serviceId, services.id))
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          eq(conversations.status, "open"),
          eq(collectionRequests.status, "active")
        )
      );

    for (const conversation of idleOpenConversations) {
      const { inactivityTimeoutMinutes } = resolveScheduleConfig(
        organization,
        conversation.service
      );
      const inactivityCutoff = new Date(
        Date.now() - inactivityTimeoutMinutes * 60 * 1000
      );
      if (conversation.updatedAt >= inactivityCutoff) continue;

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
          collectionRequestId: conversation.collectionRequestId,
        });
      }
    }

    // Ch.16 FR-16.11 / Ch.18 Reminder Interval: nudge clients who haven't
    // replied Finished/More Documents after the configured interval.
    const staleWaitingConversations = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
        updatedAt: conversations.updatedAt,
        service: services,
      })
      .from(conversations)
      .innerJoin(
        collectionRequests,
        eq(conversations.collectionRequestId, collectionRequests.id)
      )
      .innerJoin(services, eq(collectionRequests.serviceId, services.id))
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          eq(conversations.status, "waiting_for_client"),
          eq(collectionRequests.status, "waiting_for_client")
        )
      );

    for (const conversation of staleWaitingConversations) {
      const { reminderIntervalDays } = resolveScheduleConfig(
        organization,
        conversation.service
      );
      const reminderCutoff = new Date(
        Date.now() - reminderIntervalDays * 24 * 60 * 60 * 1000
      );
      if (conversation.updatedAt >= reminderCutoff) continue;

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
          collectionRequestId: conversation.collectionRequestId,
        });
      }
    }
  }

  return { evaluated, reminded };
}
