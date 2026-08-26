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
 * Collapses a label that repeats one of its own segments.
 *
 * buildPeriodLabel stops NEW labels doubling, but rows already stored keep
 * whatever they were created with — production holds
 * "בקשת מסמכים — 24.8.2026 — 24.8.2026". Fixing only the generator leaves
 * every existing request reading wrong forever, so the display layer
 * applies the same rule.
 *
 * Deliberately a general rule, not a match on that one string: any segment
 * that repeats an earlier one is dropped. Splitting is on the em/en dash
 * this codebase composes labels with (and a spaced hyphen), never a bare
 * hyphen, which appears inside ordinary words and hyphenated names.
 */
export function dedupeLabelSegments(label: string): string {
  const parts = label.split(/\s+[—–]\s+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return label.trim();
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const key = part.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept.join(" — ");
}

/**
 * The one-line description of a request: its service and its period,
 * without saying the same thing twice.
 *
 * Returns just the period label when it already begins with the service
 * name, which is the normal case for template-created requests — and
 * de-duplicates within that label too.
 */
export function describeRequestLine(serviceName: string, periodLabel: string): string {
  const service = serviceName.trim();
  const period = dedupeLabelSegments(periodLabel);
  if (!period) return service;
  if (!service) return period;
  if (period === service) return period;
  if (period.startsWith(service)) return period;
  if (service.startsWith(period)) return service;
  return `${service} · ${period}`;
}

/**
 * The metadata line for a request whose TITLE already names the client and
 * the request itself.
 *
 * The detail page showed "תקופה: מסמכים לפתיחת תיק — 19.8.2026" directly
 * under a heading reading "נועם — מסמכים לפתיחת תיק": the request's name
 * twice, one line apart, labelled as if it were a period. For a
 * template-created request the "period" IS the name plus the date it was
 * opened, so the only new information in it is the date — which is what
 * this returns. A period that carries genuinely different information (a
 * quarter, a month) is returned whole.
 */
export function describeRequestPeriodDetail(
  serviceName: string,
  periodLabel: string
): { label: string; value: string } | null {
  const service = serviceName.trim();
  const period = dedupeLabelSegments(periodLabel);
  if (!period) return null;
  if (service && period.startsWith(service)) {
    const remainder = period.slice(service.length).replace(/^\s*[—–-]\s*/, "").trim();
    // Nothing but the service name: the heading already said it.
    if (!remainder) return null;
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(remainder)) return { label: "נפתחה", value: remainder };
    return { label: "תקופה", value: remainder };
  }
  return { label: "תקופה", value: period };
}
