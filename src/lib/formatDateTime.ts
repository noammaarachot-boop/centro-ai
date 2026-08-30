/**
 * User-facing date/time formatting, always in an explicit time zone.
 *
 * `toLocaleString("he-IL", …)` without a `timeZone` formats in whatever zone
 * the RENDERING process happens to be in — UTC on Vercel. Every timestamp
 * shown to an Israeli user was therefore three hours early: a connection
 * checked at 12:02 read "09:02". Storing UTC is correct and unchanged; only
 * the display was wrong.
 *
 * Never fix this with a fixed offset. Israel moves between +02:00 and +03:00,
 * so "+3 hours" is wrong for half the year. The IANA zone carries the DST
 * rules; Intl applies whichever was in force at that instant.
 */

/**
 * Used where no organization is in context — the platform owner console
 * spans organizations, and Centro operates from Israel.
 */
export const PLATFORM_TIME_ZONE = "Asia/Jerusalem";

/** "30 באוגוסט בשעה 12:02" */
export function formatDateTime(date: Date | string, timeZone: string = PLATFORM_TIME_ZONE): string {
  return new Date(date).toLocaleString("he-IL", {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "30.8.2026" */
export function formatDate(date: Date | string, timeZone: string = PLATFORM_TIME_ZONE): string {
  return new Date(date).toLocaleDateString("he-IL", { timeZone });
}

/** "12:02" */
export function formatTime(date: Date | string, timeZone: string = PLATFORM_TIME_ZONE): string {
  return new Date(date).toLocaleTimeString("he-IL", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "יום ראשון, 30 באוגוסט" */
export function formatDayLabel(date: Date | string, timeZone: string = PLATFORM_TIME_ZONE): string {
  return new Date(date).toLocaleDateString("he-IL", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Date and time together, e.g. for an audit row. */
export function formatDateAndTime(date: Date | string, timeZone: string = PLATFORM_TIME_ZONE): string {
  return `${formatDate(date, timeZone)}, ${formatTime(date, timeZone)}`;
}
