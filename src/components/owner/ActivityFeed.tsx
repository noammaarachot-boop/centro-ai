import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { History } from "lucide-react";
import { formatOwnerDateTime } from "@/lib/owner/formatDate";
import {
  aggregateActivity,
  formatAggregatedTitle,
  type RawActivityEvent,
} from "@/lib/owner/activityFormat";

// The feed reads as a status summary, not a log. Repeated events are
// merged into one line with a count and a range; the technical event code,
// timestamps and raw rows stay available under "פרטים טכניים" rather than
// being dropped.
export function ActivityFeed({
  events,
  showOrganization = true,
  emptyTitle = "אין פעילות להצגה",
}: {
  events: RawActivityEvent[];
  showOrganization?: boolean;
  emptyTitle?: string;
}) {
  const rows = aggregateActivity(events);

  if (rows.length === 0) {
    return <EmptyState icon={History} title={emptyTitle} />;
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p
                className={`flex items-center gap-1.5 text-sm font-medium ${
                  row.severity === "problem" ? "text-danger" : "text-text-primary"
                }`}
              >
                {row.severity === "problem" && (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                {formatAggregatedTitle(row)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {row.count > 1 && (
                  <span className="text-xs text-text-muted">
                    בין {formatOwnerDateTime(row.firstOccurredAt)} ל-{formatOwnerDateTime(row.occurredAt)}
                  </span>
                )}
                {showOrganization && row.organizationName && (
                  <Badge tone="neutral">{row.organizationName}</Badge>
                )}
                {row.source === "owner" && <Badge tone="purple">פעולת בעלים</Badge>}
              </div>
            </div>
            <span className="shrink-0 whitespace-nowrap text-xs text-text-muted">
              {formatOwnerDateTime(row.occurredAt)}
            </span>
          </div>

          {/* Nothing is thrown away — the raw log is one click deep. */}
          <details className="mt-1.5">
            <summary className="cursor-pointer list-none text-[11px] font-medium text-text-muted transition-colors hover:text-brand-purple">
              פרטים טכניים
            </summary>
            <div className="mt-1.5 space-y-1 rounded-lg border border-border bg-surface-muted/50 px-3 py-2">
              <p dir="ltr" className="font-mono text-[11px] text-text-muted">
                {row.eventType}
              </p>
              {row.raw.map((raw) => (
                <p key={raw.id} className="text-[11px] text-text-secondary">
                  <span className="text-text-muted">{formatOwnerDateTime(raw.occurredAt)}</span>
                  {" — "}
                  {raw.description}
                </p>
              ))}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
