// EPS Ch.18 / BR-18.1: automated WhatsApp messages only go out during the
// firm's configured business hours and days — evaluated in the firm's own
// IANA timezone, never the server process's local time (Vercel serverless
// functions run in UTC; without this, "09:00-18:00" silently meant UTC,
// not the office's real local hours).
export interface BusinessHoursConfig {
  businessHoursStart: string; // "HH:MM"
  businessHoursEnd: string; // "HH:MM"
  businessDays: string; // comma-separated weekday numbers, 0=Sunday
  timezone: string; // IANA zone name, e.g. "Asia/Jerusalem"
}

// Epic 3: the same six fields, but resolved per Collection Request's
// Service instead of blanket per-organization — see resolveScheduleConfig.
export interface ScheduleConfig extends BusinessHoursConfig {
  reminderIntervalHours: number;
  inactivityTimeoutMinutes: number;
  // Office policy (Architecture Ch.8) — the day of the month collection
  // begins. Stored and resolved alongside the other fields for UI
  // consistency; no scheduler currently reads it (Collection Requests are
  // opened manually, not auto-created on a monthly timer).
  collectionDayOfMonth: number;
}

interface OrganizationScheduleFields {
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
  timezone: string;
  reminderIntervalHours: number;
  inactivityTimeoutMinutes: number;
  collectionDayOfMonth: number;
}

interface ServiceScheduleOverrides {
  businessHoursStartOverride: string | null;
  businessHoursEndOverride: string | null;
  businessDaysOverride: string | null;
  reminderIntervalHoursOverride: number | null;
  inactivityTimeoutMinutesOverride: number | null;
  collectionDayOfMonthOverride: number | null;
}

// Epic 3: a Service (i.e. a Business Type) may override any of the five
// scheduling fields below; a null override falls back to the organization's
// default. A service with no overrides at all (every pre-Epic-3 service)
// resolves to exactly the organization's config, so existing scheduler/
// conversation behavior is unchanged for it. Timezone itself is never
// overridable per-service — a firm's branches don't run in different
// timezones, only different hours/cadence.
export function resolveScheduleConfig(
  organization: OrganizationScheduleFields,
  service?: ServiceScheduleOverrides | null
): ScheduleConfig {
  return {
    businessHoursStart:
      service?.businessHoursStartOverride ?? organization.businessHoursStart,
    businessHoursEnd:
      service?.businessHoursEndOverride ?? organization.businessHoursEnd,
    businessDays: service?.businessDaysOverride ?? organization.businessDays,
    timezone: organization.timezone,
    reminderIntervalHours:
      service?.reminderIntervalHoursOverride ?? organization.reminderIntervalHours,
    inactivityTimeoutMinutes:
      service?.inactivityTimeoutMinutesOverride ??
      organization.inactivityTimeoutMinutes,
    collectionDayOfMonth:
      service?.collectionDayOfMonthOverride ?? organization.collectionDayOfMonth,
  };
}

// Office policy (Architecture Ch.8) — the day-of-month field's "custom"
// option submits a free-typed number; a preset option submits its own
// value directly. Either way, clamp to a real day of the month rather
// than trusting the client. Shared by the onboarding wizard's per-service
// override action and Settings' org-wide default action so both apply
// the exact same rule.
export function clampCollectionDay(value: FormDataEntryValue | null): number {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed)) return 1;
  return Math.min(Math.max(parsed, 1), 31);
}

// Same discipline as clampCollectionDay above, for the hour-granularity
// reminder interval (Bug 1 remediation) — 1-24h, never trusting the raw
// client-submitted value. Shared by the onboarding wizard's per-service
// override action and Settings' org-wide default action.
export function clampReminderHours(value: FormDataEntryValue | null): number {
  const parsed = Number(value ?? 5);
  if (!Number.isInteger(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 24);
}

// The one allowed set of values for organizations.timezone — every real
// zone this codebase's IANA-based scheduling (zonedDateParts/
// zonedWallTimeToUtc above) has actually been built and tested against.
// A single source of truth for both the Settings <select> options (never
// hand-duplicated) and server-side validation: rejecting an unlisted zone
// outright, rather than trusting a raw client-submitted string, is what
// stops a malformed value from ever reaching Intl.DateTimeFormat (which
// throws on an invalid zone name) deep inside the scheduler later.
export const SUPPORTED_TIMEZONES = [
  { value: "Asia/Jerusalem", label: "שעון ישראל (Asia/Jerusalem)" },
  { value: "UTC", label: "UTC" },
] as const;

export function isSupportedTimezone(value: string): boolean {
  return SUPPORTED_TIMEZONES.some((tz) => tz.value === value);
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedDateParts {
  weekday: number;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

// Reads a real instant's calendar date/time as it appears in `timeZone`,
// via Intl (no timezone library dependency — this codebase has none, and a
// hand-rolled Intl-based helper is enough for business-hours-granularity
// scheduling; see zonedWallTimeToUtc's own doc comment for the one accepted
// imprecision, DST-transition minutes twice a year).
// Exported for src/lib/ai/deferralIntent.ts's date resolution (a client
// committing to a real future date — "יום חמישי", "15 באוגוסט" — needs the
// exact same "what does the office's own wall clock read right now"
// primitive this module already built for business-hours checks; never a
// second, independently-maintained timezone implementation).
export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // hour12:false's "24" (midnight edge case in some ICU builds) folds to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

// How far `timeZone`'s local wall clock is ahead of UTC, in minutes, at
// roughly the given instant.
function timeZoneOffsetMinutes(utcInstant: Date, timeZone: string): number {
  const parts = zonedDateParts(utcInstant, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return (asIfUtc - utcInstant.getTime()) / 60000;
}

// The real UTC instant at which `timeZone`'s wall clock reads the given
// year/month/day/hour/minute. One correction pass (compute the zone's
// offset near the guessed instant, then apply it) — accurate outside the
// twice-yearly DST transition hour, which this business-hours use doesn't
// need to resolve to the minute; a reminder landing up to ~an hour early or
// late on the two days a year clocks change is an accepted, disclosed
// limitation, not a correctness bug for this feature.
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = timeZoneOffsetMinutes(new Date(guessUtcMs), timeZone);
  return new Date(guessUtcMs - offsetMinutes * 60000);
}

export function isWithinBusinessHours(
  config: BusinessHoursConfig,
  at: Date = new Date()
): boolean {
  const allowedDays = config.businessDays.split(",").map((d) => Number(d.trim()));
  const [startHour, startMinute] = config.businessHoursStart.split(":").map(Number);
  const [endHour, endMinute] = config.businessHoursEnd.split(":").map(Number);

  const parts = zonedDateParts(at, config.timezone);
  if (!allowedDays.includes(parts.weekday)) return false;

  const minutesNow = parts.hour * 60 + parts.minute;
  return (
    minutesNow >= startHour * 60 + startMinute &&
    minutesNow < endHour * 60 + endMinute
  );
}

// The other half of BR-18.1: when something that should only be sent
// automatically during business hours becomes due while the office is
// closed, this is *when* it should actually go out instead — the next
// moment business hours open, in the office's own timezone. Never "try
// again on the next cron tick and hope it lands in-hours" (see
// documentIntakeReview.ts's sendConfirmationRemindersAndEscalate, which
// reschedules nextReminderAt to exactly this rather than leaving a
// reminder perpetually "due" and perpetually gated).
export function nextBusinessOpenTime(config: BusinessHoursConfig, from: Date = new Date()): Date {
  const allowedDays = new Set(config.businessDays.split(",").map((d) => Number(d.trim())));
  const [startHour, startMinute] = config.businessHoursStart.split(":").map(Number);
  const [endHour, endMinute] = config.businessHoursEnd.split(":").map(Number);
  const startMinutesOfDay = startHour * 60 + startMinute;
  const endMinutesOfDay = endHour * 60 + endMinute;

  // Up to 8 days out is plenty of headroom for any real businessDays
  // configuration (even a single allowed weekday is found within a week).
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000);
    const parts = zonedDateParts(probe, config.timezone);
    if (!allowedDays.has(parts.weekday)) continue;

    if (dayOffset === 0) {
      const minutesNow = parts.hour * 60 + parts.minute;
      if (minutesNow < startMinutesOfDay) {
        return zonedWallTimeToUtc(parts.year, parts.month, parts.day, startHour, startMinute, config.timezone);
      }
      if (minutesNow < endMinutesOfDay) {
        // Already open right now — nothing to defer.
        return from;
      }
      continue; // today's window already closed; try the next allowed day
    }

    return zonedWallTimeToUtc(parts.year, parts.month, parts.day, startHour, startMinute, config.timezone);
  }

  // Unreachable for any real configuration (businessDays always has at
  // least one allowed day) — a safe, non-throwing fallback.
  return new Date(from.getTime() + 86_400_000);
}

// A vague short-term promise ("אשלח בערב", "אשלח מאוחר יותר", "אשלח
// כשאגיע הביתה") commits to no computable date — resolveDeferralDate has
// nothing to work with — but must still suppress the regular reminder for
// a bounded, honest window rather than either nagging immediately or
// inventing a specific hour the client never said. The only defensible
// reading of "later"/"soon"/"this evening" without fabricating a time: by
// the end of TODAY's business hours, if any remain — otherwise there's no
// "today" left to speak of, so this degrades to exactly
// nextBusinessOpenTime. Symmetric to that function, same primitives.
export function endOfTodayOrNextOpen(config: BusinessHoursConfig, from: Date = new Date()): Date {
  if (!isWithinBusinessHours(config, from)) return nextBusinessOpenTime(config, from);

  const [endHour, endMinute] = config.businessHoursEnd.split(":").map(Number);
  const parts = zonedDateParts(from, config.timezone);
  return zonedWallTimeToUtc(parts.year, parts.month, parts.day, endHour, endMinute, config.timezone);
}

/**
 * The office's open weekdays, as a set.
 *
 * One parse of the stored comma-separated string, shared by everything below
 * — the same shape isWithinBusinessHours and nextBusinessOpenTime already
 * derive inline from `config.businessDays`.
 */
export function parseBusinessDays(businessDays: string): Set<number> {
  return new Set(
    businessDays
      .split(",")
      .map((day) => day.trim())
      // Number("") is 0, so blank entries would silently read as Sunday and
      // turn an empty configuration into a one-day week.
      .filter((day) => day.length > 0)
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  );
}

/** The weekday of a civil date. A calendar date has one, in any timezone. */
function weekdayOfCivilDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextCivilDate(date: { year: number; month: number; day: number }) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86_400_000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

// A request left open for a decade still terminates. Real windows are days;
// this only exists so a malformed configuration cannot spin forever.
const MAX_DAYS_WALKED = 4000;

/**
 * `count` business days after `start`, keeping the same time of day.
 *
 * "Three days without an answer" means three days the office was actually
 * open. A request that goes quiet on Thursday at an office working Sunday to
 * Thursday is not two thirds of the way to needing attention by Saturday
 * night — nobody was there to be answered, and nobody was there to act.
 *
 * Counted in the office's OWN timezone, over its OWN configured days, so
 * there is nothing here that knows which days of the week are a weekend
 * anywhere in particular.
 *
 * The time of day is preserved rather than snapped to opening or closing
 * time: it keeps the window a whole number of days as a person would count
 * them, and it makes the result stable — the same start always produces the
 * same instant, which is what the attention occurrence relies on.
 *
 * Wall-clock preservation across a DST change means the elapsed milliseconds
 * may differ by an hour. That is the correct behavior for a window a human
 * expresses in days, not a rounding error.
 *
 * An office with no configured business days would have no day to advance
 * to, so every day counts — a degenerate configuration must not freeze the
 * clock and leave requests unable to ever reach attention.
 */
export function addBusinessDays(config: BusinessHoursConfig, start: Date, count: number): Date {
  const allowedDays = parseBusinessDays(config.businessDays);
  const parts = zonedDateParts(start, config.timezone);
  let cursor = { year: parts.year, month: parts.month, day: parts.day };

  let remaining = Math.max(0, Math.floor(count));
  let walked = 0;
  while (remaining > 0 && walked < MAX_DAYS_WALKED) {
    cursor = nextCivilDate(cursor);
    walked += 1;
    if (allowedDays.size === 0 || allowedDays.has(weekdayOfCivilDate(cursor.year, cursor.month, cursor.day))) {
      remaining -= 1;
    }
  }

  return zonedWallTimeToUtc(cursor.year, cursor.month, cursor.day, parts.hour, parts.minute, config.timezone);
}

/**
 * How many business days have fully passed between `start` and `now`.
 *
 * The exact inverse of addBusinessDays and deliberately so: this counts the
 * business dates whose same-time-of-day anniversary of `start` has already
 * arrived, which makes `businessDaysElapsed(start, now) >= n` true exactly
 * when `addBusinessDays(start, n) <= now`. Two functions that disagreed here
 * would put a request past its deadline while still reporting it as not yet
 * due, so they are defined against each other rather than independently.
 */
export function businessDaysElapsed(config: BusinessHoursConfig, start: Date, now: Date): number {
  if (now.getTime() <= start.getTime()) return 0;

  const allowedDays = parseBusinessDays(config.businessDays);
  const parts = zonedDateParts(start, config.timezone);
  let cursor = { year: parts.year, month: parts.month, day: parts.day };

  let elapsed = 0;
  for (let walked = 0; walked < MAX_DAYS_WALKED; walked += 1) {
    cursor = nextCivilDate(cursor);
    const instant = zonedWallTimeToUtc(
      cursor.year,
      cursor.month,
      cursor.day,
      parts.hour,
      parts.minute,
      config.timezone
    );
    if (instant.getTime() > now.getTime()) break;
    if (allowedDays.size === 0 || allowedDays.has(weekdayOfCivilDate(cursor.year, cursor.month, cursor.day))) {
      elapsed += 1;
    }
  }
  return elapsed;
}
