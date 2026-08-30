import { PLATFORM_TIME_ZONE } from "@/lib/formatDateTime";

// Shared date formatting for the Owner Dashboard.
//
// Both of these used to omit `timeZone`, which meant they formatted in the
// rendering process's own zone — UTC on Vercel. "נבדק לאחרונה" for a check
// run at 12:02 Israel time therefore displayed 09:02. The stored value was
// always correct UTC; only the display was wrong.
//
// An IANA zone, never a fixed offset: Israel moves between +02:00 and +03:00,
// so "+3 hours" would be wrong for half the year.
export function formatOwnerDate(date: Date): string {
  return date.toLocaleDateString("he-IL", {
    timeZone: PLATFORM_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatOwnerDateTime(date: Date): string {
  return date.toLocaleString("he-IL", {
    timeZone: PLATFORM_TIME_ZONE,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
