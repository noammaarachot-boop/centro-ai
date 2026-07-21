import Link from "next/link";
import { ArrowLeft, ScrollText } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listAuditLog } from "@/lib/data/auditLog";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { Badge } from "@/components/app/Badge";

const ACTOR_LABELS: Record<string, string> = {
  employee: "עובד",
  ai: "AI",
  client: "לקוח",
  system: "מערכת",
};

type Range = "today" | "7d" | "30d" | "custom";

const RANGE_LABELS: Record<Range, string> = {
  today: "היום",
  "7d": "7 ימים אחרונים",
  "30d": "30 יום אחרונים",
  custom: "טווח מותאם אישית",
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function toDateInputValue(date: Date): string {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// Every boundary is computed in server-local time — this codebase has no
// timezone infrastructure anywhere else to do otherwise (see e.g.
// relativeTime()/toLocaleString("he-IL") usage throughout the dashboards).
function resolveRange(
  range: Range,
  fromParam?: string,
  untilParam?: string
): { from: Date; to: Date } {
  const now = new Date();
  if (range === "7d") return { from: startOfDay(new Date(now.getTime() - 6 * 86400000)), to: endOfDay(now) };
  if (range === "30d") return { from: startOfDay(new Date(now.getTime() - 29 * 86400000)), to: endOfDay(now) };
  if (range === "custom") {
    const parsedFrom = fromParam ? new Date(fromParam) : null;
    const parsedUntil = untilParam ? new Date(untilParam) : null;
    if (parsedFrom && !Number.isNaN(parsedFrom.getTime()) && parsedUntil && !Number.isNaN(parsedUntil.getTime())) {
      return { from: startOfDay(parsedFrom), to: endOfDay(parsedUntil) };
    }
    // Invalid/incomplete custom range - fall back to today rather than an
    // unbounded or broken query.
    return { from: startOfDay(now), to: endOfDay(now) };
  }
  return { from: startOfDay(now), to: endOfDay(now) };
}

function dayLabel(date: Date): string {
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  if (day.getTime() === today.getTime()) return "היום";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.getTime() === yesterday.getTime()) return "אתמול";
  return day.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; until?: string }>;
}) {
  const session = await requireSession();
  const { range: rangeParam, from: fromParam, until: untilParam } = await searchParams;
  const range: Range =
    rangeParam === "7d" || rangeParam === "30d" || rangeParam === "custom" ? rangeParam : "today";
  const { from, to } = resolveRange(range, fromParam, untilParam);

  const events = await listAuditLog(session.organizationId, { from, to });

  // Events already arrive newest-first (see listAuditLog's ordering) - a
  // single reduce over them preserves that order while grouping by
  // calendar day, no extra query needed.
  const groups: { key: string; label: string; events: typeof events }[] = [];
  for (const event of events) {
    const occurredAt = new Date(event.occurredAt);
    const key = startOfDay(occurredAt).toISOString();
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.key === key) {
      lastGroup.events.push(event);
    } else {
      groups.push({ key, label: dayLabel(occurredAt), events: [event] });
    }
  }

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="פעילות"
        description={`רשומות בלתי ניתנות לעריכה של כל האירועים המשמעותיים במערכת. מוצגות רשומות מהטווח: ${RANGE_LABELS[range]}.`}
      />

      {/* Every filter here is a real navigation (<Link> with a plain href,
          a native GET <form>) - zero client JS, fully bookmarkable URLs.
          Deliberately not the Tabs component (which is client-state-driven)
          - restyled in place rather than swapped onto a different primitive. */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {(["today", "7d", "30d"] as const).map((r) => (
          <Link
            key={r}
            href={`/audit?range=${r}`}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ease-[var(--ease-standard)] ${
              range === r
                ? "border-brand-purple bg-brand-purple/10 text-brand-purple"
                : "border-border text-text-secondary hover:border-brand-purple hover:text-brand-purple"
            }`}
          >
            {RANGE_LABELS[r]}
          </Link>
        ))}
        <form action="/audit" method="GET" className="flex items-center gap-1.5">
          <input type="hidden" name="range" value="custom" />
          <input
            type="date"
            name="from"
            defaultValue={range === "custom" ? toDateInputValue(from) : undefined}
            dir="ltr"
            className={`rounded-full border px-3 py-1.5 text-xs outline-none transition-all duration-200 ease-[var(--ease-standard)] focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10 ${
              range === "custom" ? "border-brand-purple text-brand-purple" : "border-border text-text-secondary"
            }`}
          />
          <span className="text-xs text-text-muted">—</span>
          <input
            type="date"
            name="until"
            defaultValue={range === "custom" ? toDateInputValue(to) : undefined}
            dir="ltr"
            className={`rounded-full border px-3 py-1.5 text-xs outline-none transition-all duration-200 ease-[var(--ease-standard)] focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10 ${
              range === "custom" ? "border-brand-purple text-brand-purple" : "border-border text-text-secondary"
            }`}
          />
          <button
            type="submit"
            className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-text-secondary transition-colors ease-[var(--ease-standard)] hover:border-brand-purple hover:text-brand-purple"
          >
            {RANGE_LABELS.custom}
          </button>
        </form>
      </div>

      {events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="אין רשומות פעילות בטווח הזה"
          description="נסו טווח תאריכים אחר, או חזרו לכאן אחרי שתתבצע פעולה כלשהי במערכת."
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key}>
              <h2 className="mb-2.5 text-xs font-semibold text-text-muted">{group.label}</h2>
              <ul className="space-y-2.5">
                {group.events.map((event) => (
                  <li key={event.id}>
                    <Card padding="sm">
                      <div className="flex items-start justify-between gap-4">
                        <p className="text-sm text-text-primary">{event.description}</p>
                        <span className="shrink-0 text-xs text-text-muted">
                          {new Date(event.occurredAt).toLocaleTimeString("he-IL", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                        <Badge tone="neutral">
                          {ACTOR_LABELS[event.actorType] ?? event.actorType}
                          {event.actorEmail ? ` · ${event.actorEmail}` : ""}
                        </Badge>
                        <span>{event.eventType}</span>
                        {event.clientName && (
                          <span>
                            · <span className="text-text-secondary">{event.clientName}</span>
                          </span>
                        )}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה ללוח הבקרה
        </Link>
      </p>
    </div>
  );
}
