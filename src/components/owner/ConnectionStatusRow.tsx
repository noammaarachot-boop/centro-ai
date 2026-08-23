import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import type { ConnectionHealth } from "@/lib/owner/connectionHealth";

// Renders one integration's state in words, never colour alone — a red dot
// with no sentence is exactly what this replaces. "דורש טיפול" always
// carries the real reason next to it.
const PRESENTATION = {
  connected: {
    label: "מחובר",
    Icon: CheckCircle2,
    className: "text-success",
    dot: "bg-success",
  },
  not_connected: {
    // Deliberately neutral, not alarming: never having connected is an
    // expected state, not a fault.
    label: "לא מחובר",
    Icon: MinusCircle,
    className: "text-text-muted",
    dot: "bg-text-muted/50",
  },
  needs_attention: {
    label: "דורש טיפול",
    Icon: AlertTriangle,
    className: "text-danger",
    dot: "bg-danger",
  },
} as const;

export function ConnectionStatusRow({
  service,
  health,
  detail,
  compact = false,
}: {
  service: string;
  health: ConnectionHealth;
  /** Extra context when healthy (e.g. the connected phone number). */
  detail?: string | null;
  /** Inline pill form, for a dense table row. */
  compact?: boolean;
}) {
  const { label, Icon, className, dot } = PRESENTATION[health.state];

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        {service} {label}
        {health.state === "needs_attention" && health.reason && (
          <span className="text-text-muted">— {health.reason}</span>
        )}
      </span>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${className}`}>
          {service} {label}
        </p>
        {health.state === "needs_attention" && health.reason ? (
          <p className="mt-0.5 text-xs text-danger">{health.reason}</p>
        ) : (
          detail && <p className="mt-0.5 text-xs text-text-muted">{detail}</p>
        )}
      </div>
    </div>
  );
}
