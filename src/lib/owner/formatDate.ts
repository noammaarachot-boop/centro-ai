// Shared date formatting for the Owner Dashboard — matches the he-IL
// convention already established in src/app/(app)/audit/page.tsx.
export function formatOwnerDate(date: Date): string {
  return date.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

export function formatOwnerDateTime(date: Date): string {
  return date.toLocaleString("he-IL", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
