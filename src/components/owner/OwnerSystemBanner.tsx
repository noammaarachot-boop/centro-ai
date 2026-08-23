import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import type { OwnerHealthStatus } from "@/lib/owner/health";

// The one thing the owner should be able to read without scrolling: is
// anything actually broken right now.
//
// Backed by the pre-existing computeHealthStatus, which already returns
// real REASONS alongside its level — until now only its level was used, as
// a small badge in the page header. When something is wrong this states
// what, rather than turning a dot red.
const PRESENTATION = {
  healthy: {
    Icon: CheckCircle2,
    title: "המערכת תקינה",
    body: "לא נרשמו תקלות ב-24 השעות האחרונות.",
    wrapper: "border-success/30 bg-success/5",
    accent: "text-success",
  },
  warning: {
    Icon: AlertTriangle,
    title: "יש תקלות שדורשות תשומת לב",
    body: null,
    wrapper: "border-warning/40 bg-warning/5",
    accent: "text-warning",
  },
  critical: {
    Icon: ShieldAlert,
    title: "יש תקלות קריטיות",
    body: null,
    wrapper: "border-danger/40 bg-danger/5",
    accent: "text-danger",
  },
} as const;

export function OwnerSystemBanner({ status }: { status: OwnerHealthStatus }) {
  const { Icon, title, body, wrapper, accent } = PRESENTATION[status.level];

  return (
    <div className={`mb-6 rounded-2xl border px-5 py-4 ${wrapper}`} role="status">
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${accent}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className={`text-sm font-bold ${accent}`}>{title}</p>
          {status.reasons.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {status.reasons.map((reason) => (
                <li key={reason} className="text-xs text-text-secondary">
                  {reason}
                </li>
              ))}
            </ul>
          ) : (
            body && <p className="mt-0.5 text-xs text-text-secondary">{body}</p>
          )}
        </div>
      </div>
    </div>
  );
}
