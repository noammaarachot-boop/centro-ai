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
  reminderIntervalDays: number;
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
  reminderIntervalDays: number;
  inactivityTimeoutMinutes: number;
  collectionDayOfMonth: number;
}

interface ServiceScheduleOverrides {
  businessHoursStartOverride: string | null;
  businessHoursEndOverride: string | null;
  businessDaysOverride: string | null;
  reminderIntervalDaysOverride: number | null;
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
    reminderIntervalDays:
      service?.reminderIntervalDaysOverride ?? organization.reminderIntervalDays,
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
