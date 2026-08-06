import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import {
  isWithinBusinessHours,
  nextBusinessOpenTime,
  zonedDateParts,
  zonedWallTimeToUtc,
  type BusinessHoursConfig,
} from "@/lib/businessHours";
import { classifyDeferralIntent, type DeferralDateHint } from "@/lib/ai/deferralIntent";
import { applyFollowUpPromiseIfAny } from "@/lib/caseReview";

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

// The single entry point the webhook route calls in place of the old
// direct applyFollowUpPromiseIfAny call — tries the (narrower, dated-
// commitment-only) deferral classifier first; a "not_dated" result falls
// through unchanged to the existing vague-promise handling, so nothing
// about that already-working path changes for a message like "אשלח בערב".
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
    return applyFollowUpPromiseIfAny(params);
  }

  if (intent.kind === "ambiguous") {
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
      description: "הלקוח ציין שישלח מאוחר יותר, אך התאריך המדויק לא היה ברור — נשאלה שאלת הבהרה",
      actorType: "client",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
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

  const db = await getDb();
  await db
    .update(conversations)
    .set({
      deferredReminderAt: resolved.date,
      deferredReminderOriginalText: params.replyText,
      deferredReminderTimezone: businessHours.timezone,
      deferredReminderReason: resolved.humanPhrase,
    })
    .where(eq(conversations.id, params.conversationId));

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
    description: `הלקוח התחייב לשלוח מסמכים במועד עתידי — תזכורות הושהו עד ${resolved.finalDateLabel}`,
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { originalText: params.replyText, resolvedAt: resolved.date.toISOString(), reason: resolved.humanPhrase },
  });

  return true;
}
