// EPS Ch.18 / BR-18.1: automated WhatsApp messages only go out during the
// firm's configured business hours and days.
export interface BusinessHoursConfig {
  businessHoursStart: string; // "HH:MM"
  businessHoursEnd: string; // "HH:MM"
  businessDays: string; // comma-separated weekday numbers, 0=Sunday
}

// Epic 3: the same five fields, but resolved per Collection Request's
// Service instead of blanket per-organization — see resolveScheduleConfig.
export interface ScheduleConfig extends BusinessHoursConfig {
  reminderIntervalDays: number;
  inactivityTimeoutMinutes: number;
  // Office policy (Architecture Ch.8) — the day of the month collection
  // begins. Stored and resolved alongside the other four fields for UI
  // consistency; no scheduler currently reads it (Collection Requests are
  // opened manually, not auto-created on a monthly timer).
  collectionDayOfMonth: number;
}

interface OrganizationScheduleFields {
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
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

// Epic 3: a Service (i.e. a Business Type) may override any of the six
// organization-wide scheduling fields; a null override falls back to the
// organization's default. A service with no overrides at all (every
// pre-Epic-3 service) resolves to exactly the organization's config, so
// existing scheduler/conversation behavior is unchanged for it.
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

export function isWithinBusinessHours(
  config: BusinessHoursConfig,
  at: Date = new Date()
): boolean {
  const allowedDays = config.businessDays
    .split(",")
    .map((d) => Number(d.trim()));
  if (!allowedDays.includes(at.getDay())) return false;

  const [startHour, startMinute] = config.businessHoursStart
    .split(":")
    .map(Number);
  const [endHour, endMinute] = config.businessHoursEnd.split(":").map(Number);
  const minutesNow = at.getHours() * 60 + at.getMinutes();

  return (
    minutesNow >= startHour * 60 + startMinute &&
    minutesNow < endHour * 60 + endMinute
  );
}
