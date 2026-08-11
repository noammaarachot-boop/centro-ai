import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, conversations, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { escalateToHumanReview } from "@/lib/collectionRequestStateMachine";
import {
  endOfTodayOrNextOpen,
  isWithinBusinessHours,
  nextBusinessOpenTime,
  zonedDateParts,
  zonedWallTimeToUtc,
  type BusinessHoursConfig,
} from "@/lib/businessHours";
import { classifyDeferralIntent, type DeferralDateHint } from "@/lib/ai/deferralIntent";
import { classifyFollowUpIntent } from "@/lib/ai/conversationReplyIntent";

// Human-review escalation policy — a collection request gets at most this
// many client-requested deferrals (dated, vague, or ambiguous — any
// wording) before automation stops and an employee takes over. Counted by
// collectionRequests.deferralCount, never derived from message text.
const MAX_DEFERRALS = 2;
// A granted deferral genuinely restarts the 3-day completion window from
// the new date (never from the original request date) — see
// collectionRequestStateMachine.ts's applyTransition for the matching
// initial-entry case (first time into waiting_for_client).
const REVIEW_WINDOW_AFTER_DEFERRAL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Reminder deferral by explicit client commitment — "the client asked for
 * time, not a promise to interrupt them before the regular reminder cycle"
 * still applies to a *vague* promise ("אשלח בערב"), but a real dated
 * commitment ("אשלח ביום חמישי", "אשלח ב-15 באוגוסט") is a stronger
 * statement Centro must actually honor: no reminder before that date, then
 * re-check and act appropriately once it arrives. See
 * src/lib/ai/deferralIntent.ts's own doc comment for why this is a
 * separate, narrower classifier from the existing vague-promise one.
 */

const HEBREW_WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const HEBREW_WEEKDAY_LABEL = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"];
const HEBREW_MONTH_LABEL = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

function formatHebrewDateLabel(year: number, month: number, day: number): string {
  return `${day} ב${HEBREW_MONTH_LABEL[month - 1]}`;
}

function addDaysUtc(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export interface ResolvedDeferral {
  // The real UTC instant to check/send at — already resolved to a
  // business-hours-open moment (preferring the start of that day).
  date: Date;
  // A short Hebrew label for the calendar date the client's phrase itself
  // refers to (e.g. "8 באוגוסט") — this is the date as literally named,
  // even when it falls on a closed day; kept for audit/debugging context
  // about what was understood.
  dateLabel: string;
  // A short Hebrew label for the date `date` actually falls on (i.e.
  // dateLabel rolled forward to the next business opening, when needed).
  // Use this whenever telling the client when the reminder will really
  // arrive — using dateLabel there for a rolled case names a closed day
  // as if the reminder goes out then, which is simply wrong.
  finalDateLabel: string;
  // Human-readable explanation of what was understood and why, stored as
  // the deferral's own "reason" (DB audit trail) — kept verbose/technical.
  humanPhrase: string;
  // Just the relative-concept part of humanPhrase with no date attached
  // (e.g. "מחר", "בשבוע הבא"), or null when the hint itself was already a
  // specific day (explicit date / named weekday) with no separate concept
  // to name. Used to build the short, natural client-facing confirmation.
  conceptPhrase: string | null;
  // Hebrew weekday label (e.g. "יום שישי", or "שבת") for the date `date`
  // actually falls on — for the client-facing confirmation, always paired
  // with finalDateLabel rather than dateLabel, for the same reason.
  finalWeekdayLabel: string;
  rolledToNextBusinessDay: boolean;
}

// Pure, deterministic, no DB/IO — directly unit-testable. Never trusts the
// AI to have computed the date itself (see deferralIntent.ts's own doc
// comment); this is the one place that turns an extracted hint into a real
// instant, always anchored to the office's own timezone/business hours.
export function resolveDeferralDate(
  hint: DeferralDateHint,
  now: Date,
  businessHours: BusinessHoursConfig
): ResolvedDeferral | null {
  const nowParts = zonedDateParts(now, businessHours.timezone);
  let target: { year: number; month: number; day: number };
  let humanPhrase: string;
  let conceptPhrase: string | null;

  if (hint.explicitDay !== null && hint.explicitMonth !== null) {
    let year = hint.explicitYear;
    if (year === null) {
      const naiveThisYearUtc = Date.UTC(nowParts.year, hint.explicitMonth - 1, hint.explicitDay);
      const todayUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
      year = naiveThisYearUtc < todayUtc ? nowParts.year + 1 : nowParts.year;
    }
    target = { year, month: hint.explicitMonth, day: hint.explicitDay };
    humanPhrase = `בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
    conceptPhrase = null;
  } else if (hint.weekday !== null) {
    const targetWeekday = HEBREW_WEEKDAY_INDEX[hint.weekday];
    let daysAhead = (targetWeekday - nowParts.weekday + 7) % 7;
    if (daysAhead === 0) daysAhead = 7; // naming today's own weekday means next week's occurrence
    target = addDaysUtc(nowParts.year, nowParts.month, nowParts.day, daysAhead);
    humanPhrase = HEBREW_WEEKDAY_LABEL[targetWeekday];
    conceptPhrase = null;
  } else if (hint.relativeDays !== null) {
    target = addDaysUtc(nowParts.year, nowParts.month, nowParts.day, hint.relativeDays);
    const rel = hint.relativeDays === 1 ? "מחר" : hint.relativeDays === 2 ? "מחרתיים" : `בעוד ${hint.relativeDays} ימים`;
    humanPhrase = `${rel}, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
    conceptPhrase = rel;
  } else if (hint.relativeWeeks !== null) {
    target = addDaysUtc(nowParts.year, nowParts.month, nowParts.day, hint.relativeWeeks * 7);
    const rel = hint.relativeWeeks === 1 ? "בשבוע הבא" : `בעוד ${hint.relativeWeeks} שבועות`;
    humanPhrase = `${rel}, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
    conceptPhrase = rel;
  } else if (hint.namedPeriod !== null) {
    if (hint.namedPeriod === "start_of_next_week") {
      let daysAhead = (0 - nowParts.weekday + 7) % 7;
      if (daysAhead === 0) daysAhead = 7;
      target = addDaysUtc(nowParts.year, nowParts.month, nowParts.day, daysAhead);
      humanPhrase = `בתחילת השבוע הבא, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
      conceptPhrase = "בתחילת השבוע הבא";
    } else if (hint.namedPeriod === "end_of_week") {
      const allowedDays = businessHours.businessDays.split(",").map((d) => Number(d.trim()));
      const maxAllowedThisWeek = Math.max(...allowedDays);
      let daysAhead = maxAllowedThisWeek - nowParts.weekday;
      if (daysAhead <= 0) daysAhead += 7;
      target = addDaysUtc(nowParts.year, nowParts.month, nowParts.day, daysAhead);
      humanPhrase = `בסוף השבוע, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
      conceptPhrase = "בסוף השבוע";
    } else if (hint.namedPeriod === "start_of_month") {
      const month = nowParts.month === 12 ? 1 : nowParts.month + 1;
      const year = nowParts.month === 12 ? nowParts.year + 1 : nowParts.year;
      target = { year, month, day: 1 };
      humanPhrase = `בתחילת החודש הבא, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
      conceptPhrase = "בתחילת החודש הבא";
    } else {
      const lastDay = new Date(Date.UTC(nowParts.year, nowParts.month, 0)).getUTCDate();
      target = { year: nowParts.year, month: nowParts.month, day: lastDay };
      humanPhrase = `בסוף החודש, בתאריך ${formatHebrewDateLabel(target.year, target.month, target.day)}`;
      conceptPhrase = "בסוף החודש";
    }
  } else {
    return null;
  }

  const [startHour, startMinute] = businessHours.businessHoursStart.split(":").map(Number);
  const naiveTarget = zonedWallTimeToUtc(target.year, target.month, target.day, startHour, startMinute, businessHours.timezone);
  const rolledToNextBusinessDay = !isWithinBusinessHours(businessHours, naiveTarget);
  const finalDate = rolledToNextBusinessDay ? nextBusinessOpenTime(businessHours, naiveTarget) : naiveTarget;
  const finalParts = zonedDateParts(finalDate, businessHours.timezone);

  return {
    date: finalDate,
    dateLabel: formatHebrewDateLabel(target.year, target.month, target.day),
    finalDateLabel: formatHebrewDateLabel(finalParts.year, finalParts.month, finalParts.day),
    humanPhrase,
    conceptPhrase,
    finalWeekdayLabel: HEBREW_WEEKDAY_LABEL[finalParts.weekday],
    rolledToNextBusinessDay,
  };
}

// Short weekday label with the leading "יום " stripped (e.g. "יום שישי" ->
// "שישי"; "שבת" stays "שבת") — used only in the rolled-forward sentence,
// where "יום" already appears once in "יום העבודה הקרוב" and repeating it
// right after reads awkwardly.
function shortWeekdayLabel(weekdayLabel: string): string {
  return weekdayLabel.startsWith("יום ") ? weekdayLabel.slice(4) : weekdayLabel;
}

export function buildDeferralConfirmationMessage(resolved: ResolvedDeferral): string {
  if (resolved.rolledToNextBusinessDay) {
    return `בשמחה 😊 המשרד לא פעיל ביום הזה, אז אשלח לך תזכורת ביום העבודה הקרוב, ${shortWeekdayLabel(resolved.finalWeekdayLabel)} ${resolved.finalDateLabel}.`;
  }
  const prefix = resolved.conceptPhrase ? `${resolved.conceptPhrase}, ` : "";
  return `בסדר, אשלח לך תזכורת ${prefix}ב${resolved.finalWeekdayLabel} ${resolved.finalDateLabel} 😊`;
}

async function getOrgBusinessHoursConfig(organizationId: string): Promise<BusinessHoursConfig> {
  const db = await getDb();
  const [org] = await db
    .select({
      businessHoursStart: organizations.businessHoursStart,
      businessHoursEnd: organizations.businessHoursEnd,
      businessDays: organizations.businessDays,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    businessHoursStart: org?.businessHoursStart ?? "09:00",
    businessHoursEnd: org?.businessHoursEnd ?? "18:00",
    businessDays: org?.businessDays ?? "0,1,2,3,4",
    timezone: org?.timezone ?? "Asia/Jerusalem",
  };
}

// Human-review escalation policy (shared by all three deferral kinds
// below) — a single atomic UPDATE ... SET deferral_count = deferral_count
// + 1, safe under concurrent writers by Postgres row-level locking alone
// (no separate compare-and-swap needed for a plain increment). The
// deferral that would be the 3rd is never granted — escalateToHumanReview
// fires instead, immediately, with no message about the escalation itself
// (its own contract) and no wait for whatever date the client asked for.
async function claimDeferralSlot(
  organizationId: string,
  collectionRequestId: string
): Promise<{ granted: true; deferralCount: number } | { granted: false }> {
  const db = await getDb();
  const [row] = await db
    .update(collectionRequests)
    .set({ deferralCount: sql`${collectionRequests.deferralCount} + 1` })
    .where(eq(collectionRequests.id, collectionRequestId))
    .returning({ deferralCount: collectionRequests.deferralCount });

  if (!row || row.deferralCount > MAX_DEFERRALS) {
    await escalateToHumanReview(organizationId, collectionRequestId, "הלקוח ביקש דחייה בפעם השלישית", "client");
    return { granted: false };
  }
  return { granted: true, deferralCount: row.deferralCount };
}

// Writes the granted deferral itself (conversations.deferredReminderAt and
// friends — unchanged shape) and extends the request's own 3-day
// review-escalation deadline to resolvedAt + 3 days: a granted deferral
// genuinely restarts the completion window from the new date, never
// leaves the original, now-irrelevant deadline in place (see
// collectionRequestStateMachine.ts's applyTransition for the matching
// first-entry case).
async function recordGrantedDeferral(params: {
  conversationId: string;
  collectionRequestId: string;
  resolvedAt: Date;
  originalText: string;
  timezone: string;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .update(conversations)
    .set({
      deferredReminderAt: params.resolvedAt,
      deferredReminderOriginalText: params.originalText,
      deferredReminderTimezone: params.timezone,
      deferredReminderReason: params.reason,
    })
    .where(eq(conversations.id, params.conversationId));

  await db
    .update(collectionRequests)
    .set({ reviewDeadlineAt: new Date(params.resolvedAt.getTime() + REVIEW_WINDOW_AFTER_DEFERRAL_MS) })
    .where(eq(collectionRequests.id, params.collectionRequestId));
}

// The single entry point the webhook route calls for every inbound message
// the top-level classifier reads as a deferral promise. Tries the
// (narrower, dated-commitment-only) deferral classifier first; "not_dated"
// and "ambiguous" both still commit to *something* without a computable
// date, so both now also consume a deferral slot and get a bounded,
// honest defer window (endOfTodayOrNextOpen) — never nagging within the
// same window, never inventing a specific hour the client never said.
export async function applyDeferralIfAny(params: {
  organizationId: string;
  conversationId: string;
  collectionRequestId: string;
  clientId: string;
  replyText: string;
}): Promise<boolean> {
  const now = new Date();
  const businessHours = await getOrgBusinessHoursConfig(params.organizationId);
  const nowParts = zonedDateParts(now, businessHours.timezone);
  const referenceDateLabel = `${HEBREW_WEEKDAY_LABEL[nowParts.weekday]}, ${formatHebrewDateLabel(nowParts.year, nowParts.month, nowParts.day)}`;

  const intent = await classifyDeferralIntent(params.replyText, referenceDateLabel);

  if (intent.kind === "not_dated") {
    // A vague short-term promise ("אשלח בערב", "אשלח מאוחר יותר", "אשלח
    // בקרוב") — classifyDeferralIntent itself has nothing more to say
    // (no computable date); classifyFollowUpIntent is the one that
    // actually recognizes this as a promise at all, same as before this
    // policy existed.
    const isFollowUpPromise = await classifyFollowUpIntent(params.replyText);
    if (!isFollowUpPromise) return false;

    const claim = await claimDeferralSlot(params.organizationId, params.collectionRequestId);
    if (!claim.granted) return true; // escalated — no message sent about it, per policy

    const resolvedAt = endOfTodayOrNextOpen(businessHours, now);
    await recordGrantedDeferral({
      conversationId: params.conversationId,
      collectionRequestId: params.collectionRequestId,
      resolvedAt,
      originalText: params.replyText,
      timezone: businessHours.timezone,
      reason: "הלקוח ציין שישלח מאוחר יותר, ללא מועד מדויק",
    });

    // A short, human acknowledgment — never a reminder, never a question.
    await sendOutboundMessage(params.organizationId, params.conversationId, "בסדר, תודה 😊", "ai", "manual", undefined, true);

    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "conversation.reminder_deferred",
      description: `הלקוח ציין שישלח מסמכים מאוחר יותר (ללא מועד מדויק) — תזכורות הושהו (דחייה ${claim.deferralCount} מתוך ${MAX_DEFERRALS})`,
      actorType: "client",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      metadata: { originalText: params.replyText, resolvedAt: resolvedAt.toISOString(), deferralCount: claim.deferralCount },
    });
    return true;
  }

  if (intent.kind === "ambiguous") {
    const claim = await claimDeferralSlot(params.organizationId, params.collectionRequestId);
    if (!claim.granted) return true; // escalated — no clarifying question sent either, per policy

    const resolvedAt = endOfTodayOrNextOpen(businessHours, now);
    await recordGrantedDeferral({
      conversationId: params.conversationId,
      collectionRequestId: params.collectionRequestId,
      resolvedAt,
      originalText: params.replyText,
      timezone: businessHours.timezone,
      reason: "הלקוח התחייב לשלוח, אך לא ציין מועד ברור",
    });

    await sendOutboundMessage(
      params.organizationId,
      params.conversationId,
      "כדי שאדע מתי להזכיר, לאיזה יום התכוונת?",
      "ai",
      "manual",
      undefined,
      true
    );
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "conversation.deferral_clarification_requested",
      description: `הלקוח ציין שישלח מאוחר יותר, אך התאריך המדויק לא היה ברור — נשאלה שאלת הבהרה (דחייה ${claim.deferralCount} מתוך ${MAX_DEFERRALS})`,
      actorType: "client",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      metadata: { deferralCount: claim.deferralCount },
    });
    return true;
  }

  // "scheduled"
  const resolved = resolveDeferralDate(intent.dateHint, now, businessHours);
  if (!resolved) {
    await sendOutboundMessage(
      params.organizationId,
      params.conversationId,
      "כדי שאדע מתי להזכיר, לאיזה יום התכוונת?",
      "ai",
      "manual",
      undefined,
      true
    );
    return true;
  }

  const claim = await claimDeferralSlot(params.organizationId, params.collectionRequestId);
  if (!claim.granted) return true; // escalated — no confirmation sent, no wait for the requested date

  await recordGrantedDeferral({
    conversationId: params.conversationId,
    collectionRequestId: params.collectionRequestId,
    resolvedAt: resolved.date,
    originalText: params.replyText,
    timezone: businessHours.timezone,
    reason: resolved.humanPhrase,
  });

  await sendOutboundMessage(
    params.organizationId,
    params.conversationId,
    buildDeferralConfirmationMessage(resolved),
    "ai",
    "manual",
    undefined,
    true
  );

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "conversation.reminder_deferred",
    description: `הלקוח התחייב לשלוח מסמכים במועד עתידי — תזכורות הושהו עד ${resolved.finalDateLabel} (דחייה ${claim.deferralCount} מתוך ${MAX_DEFERRALS})`,
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: {
      originalText: params.replyText,
      resolvedAt: resolved.date.toISOString(),
      reason: resolved.humanPhrase,
      deferralCount: claim.deferralCount,
    },
  });

  return true;
}
