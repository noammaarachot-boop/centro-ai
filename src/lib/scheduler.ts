import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, conversations, organizations, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { resolveScheduleConfig } from "@/lib/businessHours";
import {
  evaluateAndPrompt,
  sendOutboundMessage,
} from "@/lib/conversationOrchestration";
import { attemptScheduledDelivery } from "@/lib/scheduledSend";
import { REMINDER_BODY as REMINDER_MESSAGE } from "@/lib/whatsapp/templates";
import { retryFailedDriveUploads } from "@/lib/storage/driveAdapter";
import { runRecurringCycleCreation } from "@/lib/recurringScheduler";
import {
  flushDueIntakeNotificationsForOrganization,
  sendConfirmationRemindersAndEscalate,
} from "@/lib/documentIntakeReview";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";
import { attemptFinishCollectionRequest } from "@/lib/caseReview";
import { createExtensionFinishedCheckIfDue, EXTENSION_NUDGE_AFTER_MINUTES } from "@/lib/requestExtension";

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
  delivered: number;
  driveRetried: number;
  recurringCyclesCreated: number;
  confirmationsReminded: number;
  confirmationsEscalated: number;
  intakeNotificationsFlushed: number;
}> {
  const db = await getDb();
  const allOrganizations = organizationId
    ? await db.select().from(organizations).where(eq(organizations.id, organizationId))
    : await db.select().from(organizations);

  let evaluated = 0;
  let reminded = 0;
  let confirmationsReminded = 0;
  let confirmationsEscalated = 0;
  let intakeNotificationsFlushed = 0;
  let delivered = 0;
  let driveRetried = 0;
  let recurringCyclesCreated = 0;

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
          eq(collectionRequests.status, "active"),
          // Post-completion extension flow (src/lib/requestExtension.ts)
          // has its own dedicated nudge pass below, with its own timing and
          // wording — never double-handled by this generic inactivity
          // pass, which would otherwise auto-transition it toward
          // "waiting_for_client" (and, from there, risk auto-completing it
          // before the client ever confirmed they're actually done).
          eq(collectionRequests.extensionActive, false)
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
        clientId: collectionRequests.clientId,
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
          eq(collectionRequests.status, "waiting_for_client"),
          // See the matching exclusion on idleOpenConversations above — an
          // active extension has its own dedicated nudge pass below.
          eq(collectionRequests.extensionActive, false)
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
      // Free-text "I'll send it later" understanding
      // (src/lib/ai/conversationReplyIntent.ts) — no separate deferral
      // bookkeeping needed here: the client's own message already reset
      // conversations.updatedAt (recordInboundMessage), which is exactly
      // what this staleness check measures against — a promise like "אשלח
      // בעוד שעה" is never nagged before this regular interval elapses
      // either way.
      if (conversation.updatedAt >= reminderCutoff) continue;

      // Reminder infrastructure — "ביטול תזכורת כאשר הדרישה הושלמה": a
      // request can become fully satisfied without the client ever typing
      // a "finished" phrase (e.g. the last outstanding document arrived,
      // or a document.replace resolved what was missing). Nudging with a
      // generic "still waiting for documents" reminder in that case would
      // be actively misleading — check first, and if nothing is actually
      // missing, complete the request the same way an explicit "finished"
      // signal would, instead of sending the reminder at all.
      const gateError = await checkCompletionGate(conversation.collectionRequestId);
      if (gateError === null) {
        await attemptFinishCollectionRequest({
          organizationId: organization.id,
          collectionRequestId: conversation.collectionRequestId,
          conversationId: conversation.id,
          clientId: conversation.clientId,
          actorType: "client",
        });
        continue;
      }

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

    // Product Evolution M7 — due scheduled Template sends (Workflow B's
    // "Send Request: Now or Schedule"). `scheduledAt` is null for every
    // recurring-workflow request, so this never touches anything from
    // Workflow A. attemptScheduledDelivery is the same function "Send Now"
    // calls synchronously — this is purely its retry path for requests
    // that come due later, or that missed business hours on an earlier
    // attempt.
    const dueScheduledRequests = await db
      .select({ id: collectionRequests.id, clientId: collectionRequests.clientId })
      .from(collectionRequests)
      .where(
        and(
          eq(collectionRequests.organizationId, organization.id),
          eq(collectionRequests.status, "draft"),
          isNotNull(collectionRequests.scheduledAt),
          lte(collectionRequests.scheduledAt, new Date())
        )
      );

    for (const request of dueScheduledRequests) {
      const sent = await attemptScheduledDelivery(organization.id, request.id, request.clientId);
      if (sent) delivered += 1;
    }

    // Product Evolution M9 ("Never Lose a Document") — retries every
    // document still holding a safe temporary copy after a previous Drive
    // upload failure, per organization, every tick (bounded by
    // DRIVE_RETRY_MAX_ATTEMPTS per document — see driveAdapter.ts).
    const { retried } = await retryFailedDriveUploads(organization.id);
    driveRetried += retried;

    // Product Evolution M9 ("Recurring Collection must become truly
    // automatic") — opens the next cycle for every Recurring Service /
    // client pairing whose schedule has come due, every tick. On-Demand
    // Services are structurally excluded (see recurringScheduler.ts's own
    // query), never a per-call flag that could be forgotten.
    const { created } = await runRecurringCycleCreation(organization.id);
    recurringCyclesCreated += created;

    // Ch.6 3-way document intake (src/lib/documentIntakeReview.ts) — nudges
    // clients who haven't answered an "was this intentional?" or "what
    // document is this?" question yet, and escalates to needs_review only
    // once the organization's confirmationMaxReminders is exhausted with
    // no reply. needs_review here is explicitly about non-response, never
    // about the document not matching a requirement.
    const { reminded: confirmationReminders, escalated } = await sendConfirmationRemindersAndEscalate(
      organization.id
    );
    confirmationsReminded += confirmationReminders;
    confirmationsEscalated += escalated;

    // Smart notification grouping's backstop (src/lib/pendingConfirmations.ts's
    // flushDueIntakeNotifications): the lazy flush processInboundAttachment
    // does on every new document covers a request that keeps receiving
    // documents, but a single burst followed by silence needs this tick to
    // ever actually send its question.
    const { flushed } = await flushDueIntakeNotificationsForOrganization(organization.id);
    intakeNotificationsFlushed += flushed;

    // Post-completion extension flow (src/lib/requestExtension.ts) — a
    // client who confirmed they want to add documents after a completed
    // request may upload one and go quiet without ever saying "that's
    // all." Ask once, after EXTENSION_NUDGE_AFTER_MINUTES of inactivity,
    // rather than waiting indefinitely or nagging immediately;
    // createExtensionFinishedCheckIfDue is itself a no-op if a question is
    // already open.
    const activeExtensions = await db
      .select({
        collectionRequestId: collectionRequests.id,
        clientId: collectionRequests.clientId,
        conversationUpdatedAt: conversations.updatedAt,
      })
      .from(collectionRequests)
      .innerJoin(conversations, eq(conversations.collectionRequestId, collectionRequests.id))
      .where(
        and(
          eq(collectionRequests.organizationId, organization.id),
          eq(collectionRequests.extensionActive, true),
          eq(conversations.status, "open")
        )
      );
    const extensionNudgeCutoff = new Date(Date.now() - EXTENSION_NUDGE_AFTER_MINUTES * 60 * 1000);
    for (const ext of activeExtensions) {
      if (ext.conversationUpdatedAt >= extensionNudgeCutoff) continue;
      await createExtensionFinishedCheckIfDue({
        organizationId: organization.id,
        clientId: ext.clientId,
        collectionRequestId: ext.collectionRequestId,
      });
    }
  }

  return {
    evaluated,
    reminded,
    delivered,
    driveRetried,
    recurringCyclesCreated,
    confirmationsReminded,
    confirmationsEscalated,
    intakeNotificationsFlushed,
  };
}
