// EPS Ch.18 / BR-18.1: automated WhatsApp messages only go out during the
// firm's configured business hours and days.
export interface BusinessHoursConfig {
  businessHoursStart: string; // "HH:MM"
  businessHoursEnd: string; // "HH:MM"
  businessDays: string; // comma-separated weekday numbers, 0=Sunday
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
