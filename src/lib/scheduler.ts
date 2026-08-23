import { and, eq, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, conversations, messages, organizations, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { isWithinBusinessHours, nextBusinessOpenTime, resolveScheduleConfig } from "@/lib/businessHours";
import {
  evaluateAndPrompt,
  sendOutboundMessage,
} from "@/lib/conversationOrchestration";
import { attemptScheduledDelivery } from "@/lib/scheduledSend";
import { buildReminderSend } from "@/lib/reminderContent";
import { retryFailedDriveUploads } from "@/lib/storage/driveAdapter";
import { runRecurringCycleCreation } from "@/lib/recurringScheduler";
import { pollTemplateApprovalIfDue } from "@/lib/whatsapp/templateApprovalNotice";
import {
  flushDueIntakeNotificationsForOrganization,
  sendConfirmationRemindersAndEscalate,
} from "@/lib/documentIntakeReview";
import { checkCompletionGate, escalateToHumanReview, isWaitingForClientCondition } from "@/lib/collectionRequestStateMachine";
import { attemptFinishCollectionRequest, runAutomaticCaseStatusReview } from "@/lib/caseReview";
import { createExtensionFinishedCheckIfDue, EXTENSION_NUDGE_AFTER_MINUTES } from "@/lib/requestExtension";
import { captureError } from "@/lib/monitoring/errorReporting";

// Phase 6.4 (Production Hardening) — Phase 3.1's send-before-DB-write fix
// closed the crash window where a real WhatsApp send left zero record at
// all, by writing a "pending" messages row before the Meta call and only
// finalizing it (whatsappMessageId/deliveryStatus) after. That narrows,
// but doesn't eliminate, a crash window: a function killed between the
// Meta call and that final UPDATE leaves the row stuck at "pending"
// forever, with no way to know after the fact whether Meta actually
// delivered it — Meta exposes no "did message X go out" lookup without
// the whatsappMessageId this row never received. Auto-resending would
// risk a genuine duplicate the client actually reads twice, exactly what
// Phase 3.1 was closing — so this only ever detects and flags for a human
// to check, never resends. Generous enough that no send legitimately still
// in flight (even through withRetry's backoff) could be mistaken for
// stuck.
const STUCK_PENDING_MESSAGE_AGE_MS = 10 * 60 * 1000;

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
  caseStatusReviewsRun: number;
  stuckMessagesFlagged: number;
  /** Organizations whose template approval was polled from Meta this tick. */
  templateApprovalPolls: number;
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
  let templateApprovalPolls = 0;
  let caseStatusReviewsRun = 0;
  let stuckMessagesFlagged = 0;

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

      // Atomic claim (Phase 4.2 remediation, same compare-and-swap pattern
      // already used below for deferredReminderAt/pendingCaseReviewAt) —
      // two concurrent scheduler ticks reading the same idleOpenConversations
      // row before either one's own write commits could otherwise both
      // call evaluateAndPrompt, both send the real thank-you WhatsApp
      // message, and both attempt the same open->waiting_for_client
      // transition. Bumping updatedAt here — even though evaluateAndPrompt
      // itself may end up doing nothing this round (checkCompletionGate not
      // yet satisfied) — is a deliberate tradeoff: a conversation that's
      // not yet ready gets re-evaluated on the next full
      // inactivityTimeoutMinutes cycle rather than on literally every tick,
      // in exchange for it being genuinely impossible for two ticks to ever
      // race on the same conversation here.
      const claimed = await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(and(eq(conversations.id, conversation.id), eq(conversations.updatedAt, conversation.updatedAt)))
        .returning({ id: conversations.id });
      if (claimed.length === 0) continue; // lost the race to another tick

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
    //
    // Root-cause fix (2026-08-15 production incident — reminders never
    // fired at all): widened from waiting_for_client-only. evaluateAndPrompt
    // (the only place that used to set a request up for a reminder) never
    // transitions a conversation to waiting_for_client while any requirement
    // is still unsatisfied — see its own doc comment — so a request with
    // zero or partial documents stayed on status=active/open forever and
    // never reached this pass at all. Added second branch below: same
    // reminderAnchorAt/reminderIntervalHours/business-hours machinery,
    // applied to status=active/open too. reminderAnchorAt already anchors
    // correctly for this case with no further change needed: it defaults to
    // the conversation's own creation time (real request-sent time) and is
    // never reset by an inbound message, so a request recovered into this
    // pass keeps its real historical clock rather than resetting to "now".
    const staleWaitingConversations = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
        clientId: collectionRequests.clientId,
        clientName: clients.name,
        conversationStatus: conversations.status,
        reminderAnchorAt: conversations.reminderAnchorAt,
        deferredReminderAt: conversations.deferredReminderAt,
        reviewDeadlineAt: collectionRequests.reviewDeadlineAt,
        service: services,
      })
      .from(conversations)
      .innerJoin(
        collectionRequests,
        eq(conversations.collectionRequestId, collectionRequests.id)
      )
      .innerJoin(services, eq(collectionRequests.serviceId, services.id))
      .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          // Shared with any other "is the system waiting on the client"
          // consumer (e.g. a dashboard) via collectionRequestStateMachine.ts
          // — never redeclared here, so there is exactly one definition.
          isWaitingForClientCondition(),
          // See the matching exclusion on idleOpenConversations above — an
          // active extension has its own dedicated nudge pass below.
          eq(collectionRequests.extensionActive, false)
        )
      );

    for (const conversation of staleWaitingConversations) {
      const scheduleConfig = resolveScheduleConfig(organization, conversation.service);
      const { reminderIntervalHours } = scheduleConfig;

      // Checked first, before escalation and before any reminder logic, on
      // every tick regardless of staleness — "ביטול תזכורת כאשר הדרישה
      // הושלמה": a request can become fully satisfied without the client
      // ever typing a "finished" phrase (e.g. the last outstanding document
      // arrived, or a document.replace resolved what was missing). Re-run
      // fresh on every tick — never a cached/stale list — so a request that
      // becomes complete between one tick and the next stops being nagged
      // immediately, and the exact missing set below is always current.
      // Critically, this must run BEFORE the review-deadline escalation
      // check below — a request that's actually fully satisfied must never
      // be escalated to human review just because reviewDeadlineAt happens
      // to have already passed by the time this tick got to it.
      const gateError = await checkCompletionGate(conversation.collectionRequestId);
      if (gateError === null) {
        // status=active/open only reaches this loop via the widened branch
        // above; idleOpenConversations (earlier in this same tick) is the
        // sole, pre-existing owner of that transition (thank-you send +
        // move to waiting_for_client) — completing it here too would mean
        // a client who just sent their last document, on a conversation
        // already idle past inactivityTimeoutMinutes, gets both that
        // thank-you AND this completion message in the same tick. Skip
        // silently; idleOpenConversations already catches it this tick or
        // the next.
        if (conversation.conversationStatus === "open") continue;
        await attemptFinishCollectionRequest({
          organizationId: organization.id,
          collectionRequestId: conversation.collectionRequestId,
          conversationId: conversation.id,
          clientId: conversation.clientId,
          actorType: "client",
        });
        continue;
      }

      // Human-review escalation (3-day completion window) — a request
      // overdue for review must never also receive a reminder in the same
      // tick, and once escalated it must never re-enter the reminder
      // machinery below (escalateToHumanReview's own CAS guards against a
      // concurrent tick double-firing; a request that's already been
      // claimed by another tick simply no-ops here). reviewDeadlineAt is
      // only ever set by evaluateAndPrompt, so it's always null for a
      // status=active/open request reached via the widened branch above —
      // this check naturally never fires for that case.
      if (conversation.reviewDeadlineAt && conversation.reviewDeadlineAt <= new Date()) {
        await escalateToHumanReview(
          organization.id,
          conversation.collectionRequestId,
          "לא ענה — חלפו 3 ימים והבקשה עדיין לא הושלמה",
          "system"
        );
        continue;
      }

      // restoreOnFailure — set by whichever branch below actually claims a
      // send attempt, and invoked only if the attempt doesn't genuinely
      // result in deliveryStatus "sent". Without this, a real send failure
      // (Meta rejection, no_template, invalid_phone — anything short of an
      // actual delivery) would silently consume a full reminder cycle: the
      // claim already moved the anchor forward, so the client would wait a
      // full reminderIntervalHours (or until the original deferred date)
      // for a reminder they never actually received. Same restore-on-
      // failure discipline already established in
      // documentIntakeReview.ts's sendConfirmationRemindersAndEscalate.
      let restoreOnFailure: (() => Promise<void>) | null = null;

      // Reminder deferral by explicit client commitment
      // (src/lib/reminderDeferral.ts) — a genuine dated promise ("אשלח ביום
      // חמישי") suppresses the normal reminderIntervalHours staleness check
      // entirely until that date, regardless of how long the conversation
      // has been idle. A vague short-term promise ("אשלח בערב") is now
      // ALSO recorded here (reminderDeferral.ts's endOfTodayOrNextOpen
      // path) — see that module's own doc comments; this branch no longer
      // assumes only a dated commitment ever sets deferredReminderAt.
      if (conversation.deferredReminderAt) {
        if (conversation.deferredReminderAt > new Date()) continue; // not due yet

        const originalDeferredReminderAt = conversation.deferredReminderAt;
        // Atomic claim (same compare-and-swap pattern as
        // flushDueIntakeNotifications) — prevents two concurrent scheduler
        // ticks from both acting on the same due deferral. Clears the
        // deferral unconditionally; a business-hours gate below restores
        // it (rescheduled) if the send can't actually go out right now.
        const claimed = await db
          .update(conversations)
          .set({ deferredReminderAt: null })
          .where(and(eq(conversations.id, conversation.id), eq(conversations.deferredReminderAt, conversation.deferredReminderAt)))
          .returning({ id: conversations.id });
        if (claimed.length === 0) continue; // lost the race to another tick

        if (!isWithinBusinessHours(scheduleConfig)) {
          await db
            .update(conversations)
            .set({ deferredReminderAt: nextBusinessOpenTime(scheduleConfig) })
            .where(eq(conversations.id, conversation.id));
          continue;
        }
        // Due and within business hours — fall through to the same
        // gate-check-then-send-or-complete logic as a normal stale
        // reminder, just without the interval-staleness gate above.
        restoreOnFailure = async () => {
          await db
            .update(conversations)
            .set({ deferredReminderAt: originalDeferredReminderAt })
            .where(eq(conversations.id, conversation.id));
        };
      } else {
        const reminderCutoff = new Date(Date.now() - reminderIntervalHours * 60 * 60 * 1000);
        if (conversation.reminderAnchorAt >= reminderCutoff) continue;

        const originalReminderAnchorAt = conversation.reminderAnchorAt;
        // Atomic claim (Phase 4.3 remediation; Bug 3 remediation — claims
        // on reminderAnchorAt, never conversations.updatedAt, so an inbound
        // client message can never reset or delay this cycle). Bumped even
        // on a round that ends up deferred (business hours closed) rather
        // than sent — same accepted tradeoff already documented for
        // idleOpenConversations above: re-evaluated on the next cycle
        // rather than every tick, never double-processed. A genuine send
        // failure (as opposed to a business-hours defer) is restored via
        // restoreOnFailure below, never left silently "consumed".
        //
        // Root-cause fix (2026-08-18 production incident — a request's
        // very first reminder attempt could never succeed, ever) —
        // reminderAnchorAt's column default is Postgres's own now(), which
        // carries real microsecond precision; a JS Date can only ever
        // represent milliseconds. For a conversation whose reminderAnchorAt
        // still holds that original, never-yet-claimed default value, a
        // plain eq() comparison here compares the column's true
        // microsecond-precision value against a parameter that already lost
        // its sub-millisecond digits on the round trip through JS — never
        // equal, every single time, deterministically (not the "lost the
        // race to a concurrent tick" this claim otherwise guards against).
        // date_trunc('milliseconds', ...) on the column side makes the
        // comparison symmetric with what a JS Date can actually hold, so a
        // genuinely untouched row can be claimed on its very first attempt,
        // while still correctly failing to match if some other write really
        // did change the value in the meantime.
        const claimed = await db
          .update(conversations)
          .set({ reminderAnchorAt: new Date() })
          .where(
            and(
              eq(conversations.id, conversation.id),
              sql`date_trunc('milliseconds', ${conversations.reminderAnchorAt}) = ${conversation.reminderAnchorAt.toISOString()}::timestamptz`
            )
          )
          .returning({ id: conversations.id });
        if (claimed.length === 0) continue; // lost the race to another tick

        if (!isWithinBusinessHours(scheduleConfig)) {
          // Bug 2 remediation — a reminder due while the office is closed
          // must defer to the next opening, never silently vanish. Reuses
          // the exact same deferredReminderAt/nextBusinessOpenTime
          // mechanism the branch above already relies on for a client
          // commitment, so the sibling branch picks it up on a later tick.
          await db
            .update(conversations)
            .set({ deferredReminderAt: nextBusinessOpenTime(scheduleConfig) })
            .where(eq(conversations.id, conversation.id));
          await recordAuditEvent({
            organizationId: organization.id,
            eventType: "scheduler.reminder_deferred_outside_hours",
            description: "תזכורת שהגיעה מחוץ לשעות הפעילות נדחתה לפתיחת יום העסקים הבא",
            actorType: "system",
            collectionRequestId: conversation.collectionRequestId,
          });
          continue;
        }
        restoreOnFailure = async () => {
          await db
            .update(conversations)
            .set({ reminderAnchorAt: originalReminderAnchorAt })
            .where(eq(conversations.id, conversation.id));
        };
      }

      // organization.reminderV2Approved — THIS organization's own Meta
      // template-approval state (Phase 2.1 remediation), never the old
      // global flag (Meta approves per-WABA, not for every connected
      // office at once). buildReminderSend re-reads the requirement/
      // document state fresh on every call (listMissingRequirementNames —
      // no caching), so the missing-items list is always the current one,
      // never stale text from an earlier tick.
      const reminderSend = await buildReminderSend(
        conversation.id,
        conversation.collectionRequestId,
        conversation.clientName,
        organization.reminderV2Approved
      );
      // deliveryStatus, not the broader `sent` flag, is the true signal —
      // sendOutboundMessage returns sent:true for any attempt that wasn't
      // blocked by the automation gate, even one Meta itself rejected
      // (deliveryStatus "failed"/"not_connected"/"no_template"/
      // "invalid_phone"). Only deliveryStatus === "sent" is a genuine
      // delivery — the same distinction startConversation already relies on
      // for its own v2-template-rejection fallback.
      const { deliveryStatus } = await sendOutboundMessage(
        organization.id,
        conversation.id,
        reminderSend.body,
        "ai",
        "automated",
        reminderSend.templateSend,
        reminderSend.allowFreeform
      );
      if (deliveryStatus === "sent") {
        reminded += 1;
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "scheduler.reminder_sent",
          description: "תזכורת אוטומטית נשלחה עקב חוסר תגובה",
          actorType: "system",
          collectionRequestId: conversation.collectionRequestId,
        });
      } else {
        if (restoreOnFailure) await restoreOnFailure();
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "scheduler.reminder_send_failed",
          description: `שליחת תזכורת אוטומטית נכשלה (${deliveryStatus ?? "blocked"}) — המחזור ינוסה שוב בטיק הבא, לא נחשב כתזכורת שנשלחה`,
          actorType: "system",
          collectionRequestId: conversation.collectionRequestId,
        });
      }
    }

    // Silence-window case review (src/lib/caseReview.ts's
    // runAutomaticCaseStatusReview) — a completely different timescale and
    // trigger from the reminderIntervalDays pass just above: this fires
    // once, ~2 minutes after the LAST document arrived (conversationActions.ts
    // resets pendingCaseReviewAt on every attachment), never waiting for a
    // "סיימתי" from the client. Deliberately NOT business-hours-gated —
    // unlike the staleness reminder above, this is a direct reaction to
    // activity the client themselves just initiated, not a cold nudge, so
    // it runs 24/7 (runAutomaticCaseStatusReview's own send uses "manual"
    // trigger for exactly this reason). Never touches deferredReminderAt/
    // the staleness reminder above — a request can be silence-summarized
    // and still separately reminded days later if it's still incomplete by
    // then. Extension-active requests are excluded (their own
    // extension_finished_check nudge covers that case) and never even get
    // pendingCaseReviewAt set to begin with.
    const dueCaseReviews = await db
      .select({
        id: conversations.id,
        collectionRequestId: conversations.collectionRequestId,
        clientId: collectionRequests.clientId,
        pendingCaseReviewAt: conversations.pendingCaseReviewAt,
      })
      .from(conversations)
      .innerJoin(collectionRequests, eq(conversations.collectionRequestId, collectionRequests.id))
      .where(
        and(
          eq(conversations.organizationId, organization.id),
          isNotNull(conversations.pendingCaseReviewAt),
          lte(conversations.pendingCaseReviewAt, new Date()),
          eq(collectionRequests.extensionActive, false),
          // finalizeCompletion (caseReview.ts) already clears
          // pendingCaseReviewAt the moment a request completes, but this
          // is excluded defensively too — a completed/cancelled request
          // should never get a status summary regardless of how its
          // pendingCaseReviewAt column ended up still set.
          notInArray(collectionRequests.status, ["completed", "cancelled"])
        )
      );

    for (const conversation of dueCaseReviews) {
      // Atomic claim — same compare-and-swap pattern as the deferred-
      // reminder due-check above and flushDueIntakeNotifications: two
      // concurrent scheduler ticks can never both act on the same due
      // window, so a burst of documents followed by silence always
      // produces exactly one summary, never two.
      const claimed = await db
        .update(conversations)
        .set({ pendingCaseReviewAt: null })
        .where(and(eq(conversations.id, conversation.id), eq(conversations.pendingCaseReviewAt, conversation.pendingCaseReviewAt!)))
        .returning({ id: conversations.id });
      if (claimed.length === 0) continue; // lost the race to another tick

      const outcome = await runAutomaticCaseStatusReview({
        organizationId: organization.id,
        collectionRequestId: conversation.collectionRequestId,
        conversationId: conversation.id,
        clientId: conversation.clientId,
      });
      caseStatusReviewsRun += 1;
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "scheduler.case_status_review_run",
        description: `סיכום מצב אוטומטי לאחר 2 דקות שקט: ${outcome}`,
        actorType: "system",
        collectionRequestId: conversation.collectionRequestId,
      });
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

    // Meta approves a WhatsApp template hours or days after submission,
    // and tells nobody. Without this, the office owner's "your templates
    // are approved" email would only go out if the platform owner happened
    // to open the organization's page and press refresh.
    //
    // Self-throttling and self-terminating: it contacts Meta at most once
    // per organization per hour, and stops considering an organization
    // entirely once its email has been sent (see pollTemplateApprovalIfDue).
    if (await pollTemplateApprovalIfDue(organization.id)) {
      templateApprovalPolls += 1;
    }

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

    // Phase 6.4 — see STUCK_PENDING_MESSAGE_AGE_MS's own doc comment above.
    // Transitions the row to a distinct terminal "stuck" deliveryStatus
    // (not a resend, not left as "pending") — both so it reads honestly
    // (neither confirmed sent nor confirmed failed — genuinely unknown)
    // and so this same row is never re-flagged on every later tick.
    const stuckPendingCutoff = new Date(Date.now() - STUCK_PENDING_MESSAGE_AGE_MS);
    const stuckPendingMessages = await db
      .select({ id: messages.id, conversationId: messages.conversationId, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, organization.id),
          eq(messages.direction, "outbound"),
          eq(messages.deliveryStatus, "pending"),
          lte(messages.createdAt, stuckPendingCutoff)
        )
      );
    for (const stuck of stuckPendingMessages) {
      const claimed = await db
        .update(messages)
        .set({ deliveryStatus: "stuck" })
        .where(and(eq(messages.id, stuck.id), eq(messages.deliveryStatus, "pending")))
        .returning({ id: messages.id });
      if (claimed.length === 0) continue; // another tick already flagged it
      console.error("[scheduler] stuck pending outbound message detected — delivery outcome unknown, needs manual check", {
        organizationId: organization.id,
        messageId: stuck.id,
        conversationId: stuck.conversationId,
        ageMs: Date.now() - stuck.createdAt.getTime(),
      });
      captureError(new Error("Stuck pending outbound WhatsApp message"), {
        organizationId: organization.id,
        messageId: stuck.id,
        conversationId: stuck.conversationId,
      });
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "message.stuck_pending",
        description: "הודעה יוצאת נתקעה במצב 'ממתין לשליחה' ללא עדכון סופי — נדרשת בדיקה ידנית מול WhatsApp",
        actorType: "system",
        metadata: { messageId: stuck.id, conversationId: stuck.conversationId },
      });
      stuckMessagesFlagged += 1;
    }
  }

  return {
    evaluated,
    reminded,
    delivered,
    driveRetried,
    recurringCyclesCreated,
    templateApprovalPolls,
    confirmationsReminded,
    confirmationsEscalated,
    intakeNotificationsFlushed,
    caseStatusReviewsRun,
    stuckMessagesFlagged,
  };
}
