/**
 * How a collection request is labelled, and how that label is shown.
 *
 * Two separate defects met on the dashboard's "בקשות בתהליך" row, which
 * renders `serviceName · periodLabel`:
 *
 *  1. The label was built as `${template.name} — ${today}`, with no check
 *     that the template's own name already ended in a date. Production
 *     holds "בקשת מסמכים — 24.8.2026 — 24.8.2026".
 *  2. Even a correct label repeats the service name, because the label is
 *     DERIVED from it — so the row read "בקשת מסמכים — 24.8.2026 · בקשת
 *     מסמכים — 24.8.2026 — 24.8.2026".
 *
 * buildPeriodLabel fixes new data; describeRequestLine fixes the display,
 * including for the rows already stored.
 */

/** The date suffix this module appends, in the organization's own zone. */
export function formatLabelDate(at: Date, timeZone: string): string {
  return at.toLocaleDateString("he-IL", { timeZone });
}

/**
 * A period label for a request created from a template.
 *
 * Never appends a date the name already carries — a template someone named
 * "בקשת מסמכים — 24.8.2026" must not become that name plus today's date
 * again.
 */
export function buildPeriodLabel(templateName: string, at: Date, timeZone: string): string {
  const name = templateName.trim();
  const date = formatLabelDate(at, timeZone);
  if (name.includes(date)) return name;
  // Any trailing date at all, not just today's — re-sending a template
  // named after an older date should not stack a second one onto it.
  if (/[—-]\s*\d{1,2}\.\d{1,2}\.\d{2,4}\s*$/.test(name)) return name;
  return `${name} — ${date}`;
}

/**
 * The one-line description of a request: its service and its period,
 * without saying the same thing twice.
 *
 * Returns just the period label when it already begins with the service
 * name, which is the normal case for template-created requests.
 */
export function describeRequestLine(serviceName: string, periodLabel: string): string {
  const service = serviceName.trim();
  const period = periodLabel.trim();
  if (!period) return service;
  if (!service) return period;
  if (period === service) return period;
  if (period.startsWith(service)) return period;
  if (service.startsWith(period)) return service;
  return `${service} · ${period}`;
}
