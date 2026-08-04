import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { clientServices, collectionRequests, organizations, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { resolveScheduleConfig } from "@/lib/businessHours";
import { snapshotServiceRequirements } from "@/lib/collectionRequestStateMachine";
import { startConversation } from "@/lib/conversationOrchestration";

/**
 * Product Evolution M9 ("Recurring Collection must become truly
 * automatic") — the piece that was completely missing before this: Centro
 * previously stored a collection day but never actually opened the next
 * cycle on its own (collection requests were only ever created by an
 * employee clicking a button). This module is the real engine, called
 * every cron tick from src/lib/scheduler.ts alongside the existing
 * reminder/inactivity/scheduled-send passes.
 *
 * Deliberately separate from src/lib/businessHours.ts: frequency (when a
 * NEW cycle starts) and reminders (what happens inside an already-open
 * cycle) are different concepts with different owners in the data model —
 * see services.collectionFrequencyIntervalMonths vs.
 * organizations/services' five reminder/business-hours fields.
 *
 * Server-side guarantee (not just a UI choice): every query below filters
 * on services.collectionMode = "recurring" — an On-Demand Service can
 * never be picked up here no matter what, because collectionMode is a
 * schema column, not a request the caller could omit or a flag that could
 * be forgotten at one call site.
 */

// A bare integer 1-31, clamped exactly like clampCollectionDay
// (src/lib/businessHours.ts) — duplicated rather than imported since that
// function's contract is "parse an untrusted form value," not "clamp an
// already-numeric day," and importing it here would blur that boundary.
function clampDay(day: number): number {
  if (!Number.isInteger(day)) return 1;
  return Math.min(Math.max(day, 1), 31);
}

// JS Date's month arg overflows/underflows correctly on its own (month 12
// becomes January of the next year, month -1 becomes December of the
// previous year), so advancing by N months is just `month + N` — the only
// real subtlety is clamping the day for months shorter than the anchor day
// (e.g. anchor day 31 in a 30-day month), per organizations.collectionDayOfMonth's
// own schema comment about why this was never calendar-aware before.
function dateForMonth(year: number, month: number, day: number): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth), 0, 0, 0, 0);
}

// The very first schedule computed for a client freshly assigned to a
// Recurring Service: the next upcoming occurrence of the anchor day, never
// today itself retroactively (an office assigning a client mid-month
// doesn't get a surprise cycle immediately — they can always open one by
// hand right away if they want that; the automatic engine only ever looks
// forward). Exported for callers that assign clients to Services
// (src/lib/businessTypes.ts) to set the initial value.
export function computeInitialCollectionRunAt(
  anchorDay: number,
  from: Date = new Date()
): Date {
  const day = clampDay(anchorDay);
  const candidate = dateForMonth(from.getFullYear(), from.getMonth(), day);
  if (candidate.getTime() > from.getTime()) return candidate;
  return dateForMonth(from.getFullYear(), from.getMonth() + 1, day);
}

// Advances from the *previous scheduled date*, not "now" — so a cycle that
// happens to run a few hours or days late (a paused automation, a down
// cron) never drifts the schedule forward; the next one is still exactly
// intervalMonths after where this one was supposed to land.
export function advanceCollectionRunAt(
  previousRunAt: Date,
  anchorDay: number,
  intervalMonths: number
): Date {
  const day = clampDay(anchorDay);
  return dateForMonth(
    previousRunAt.getFullYear(),
    previousRunAt.getMonth() + Math.max(intervalMonths, 1),
    day
  );
}

const HEBREW_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

// A reasonable, readable default label for an auto-created cycle — e.g.
// "ינואר 2026" for a monthly cadence, "ינואר–מרץ 2026" for a quarterly one
// covering the three months ending now. Purely a display label
// (collectionRequests.periodLabel) — never parsed back, so getting the
// exact month boundary philosophy "right" for every edge case isn't
// load-bearing; this just needs to read naturally.
export function formatAutoPeriodLabel(at: Date, intervalMonths: number): string {
  const endMonth = HEBREW_MONTHS[at.getMonth()];
  if (intervalMonths <= 1) return `${endMonth} ${at.getFullYear()}`;

  const startDate = new Date(at.getFullYear(), at.getMonth() - (intervalMonths - 1), 1);
  const startMonth = HEBREW_MONTHS[startDate.getMonth()];
  return startDate.getFullYear() === at.getFullYear()
    ? `${startMonth}–${endMonth} ${at.getFullYear()}`
    : `${startMonth} ${startDate.getFullYear()}–${endMonth} ${at.getFullYear()}`;
}

interface DueRow {
  clientServiceId: string;
  clientId: string;
  serviceId: string;
  nextCollectionRunAt: Date | null;
  service: typeof services.$inferSelect;
}

async function createAndSendRecurringCycle(
  organization: typeof organizations.$inferSelect,
  row: DueRow
) {
  const db = await getDb();
  const intervalMonths = row.service.collectionFrequencyIntervalMonths ?? 1;
  const now = new Date();
  const periodLabel = formatAutoPeriodLabel(now, intervalMonths);

  const [collectionRequest] = await db
    .insert(collectionRequests)
    .values({
      organizationId: organization.id,
      clientId: row.clientId,
      serviceId: row.serviceId,
      periodLabel,
      status: "draft",
    })
    .returning();

  await snapshotServiceRequirements(collectionRequest.id, row.serviceId, organization.id, row.clientId);

  await recordAuditEvent({
    organizationId: organization.id,
    eventType: "collection_request.auto_created",
    description: `Centro פתח אוטומטית מחזור איסוף חדש עבור התקופה ${periodLabel}`,
    actorType: "system",
    clientId: row.clientId,
    collectionRequestId: collectionRequest.id,
  });

  // Advance the schedule before attempting the send — a slow or failed
  // send must never cause the same pairing to be picked up again on the
  // very next tick and double-create a cycle for the same period.
  const anchorDay = resolveScheduleConfig(organization, row.service).collectionDayOfMonth;
  const baseline = row.nextCollectionRunAt ?? now;
  const nextRunAt = advanceCollectionRunAt(baseline, anchorDay, intervalMonths);
  await db
    .update(clientServices)
    .set({ nextCollectionRunAt: nextRunAt })
    .where(eq(clientServices.id, row.clientServiceId));

  // The same real send path a manual "initiate" uses (startConversation) —
  // already degrades gracefully (recorded, never thrown) if WhatsApp isn't
  // connected or automation is paused, via sendOutboundMessage's own
  // gates. On success, mirrors initiateConversation's draft -> active
  // transition.
  const { sent } = await startConversation(organization.id, collectionRequest.id, row.clientId);
  if (sent) {
    await db
      .update(collectionRequests)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(collectionRequests.id, collectionRequest.id));
  }
}

// The cron entry point — src/lib/scheduler.ts calls this once per
// organization on every tick, exactly like its other passes.
export async function runRecurringCycleCreation(organizationId?: string): Promise<{ created: number }> {
  const db = await getDb();
  const allOrganizations = organizationId
    ? await db.select().from(organizations).where(eq(organizations.id, organizationId))
    : await db.select().from(organizations);

  let created = 0;
  for (const organization of allOrganizations) {
    // The same org-wide gate sendOutboundMessage now enforces: an
    // organization with automated document collection disabled never gets
    // an automatically-created recurring cycle. documentCollectionEnabled
    // is the source of truth (backfilled true for connected orgs);
    // automationActivatedAt is retained elsewhere only for transitional
    // compatibility and is no longer consulted here.
    if (!organization.documentCollectionEnabled) continue;

    const dueRows = await db
      .select({
        clientServiceId: clientServices.id,
        clientId: clientServices.clientId,
        serviceId: clientServices.serviceId,
        nextCollectionRunAt: clientServices.nextCollectionRunAt,
        service: services,
      })
      .from(clientServices)
      .innerJoin(services, eq(clientServices.serviceId, services.id))
      .where(
        and(
          eq(services.organizationId, organization.id),
          eq(services.collectionMode, "recurring"),
          isNull(services.automationPausedAt),
          isNotNull(services.collectionFrequencyIntervalMonths),
          isNotNull(clientServices.nextCollectionRunAt),
          lte(clientServices.nextCollectionRunAt, new Date())
        )
      );

    for (const row of dueRows) {
      await createAndSendRecurringCycle(organization, row as DueRow);
      created += 1;
    }
  }

  return { created };
}
