import type { OwnerHealthStatus } from "@/lib/owner/health";
import { t } from "@/lib/owner/i18n/t";

const LEVEL_EMOJI: Record<OwnerHealthStatus["level"], string> = {
  healthy: "🟢",
  warning: "🟡",
  critical: "🔴",
};

const LEVEL_LABEL_KEY: Record<OwnerHealthStatus["level"], "owner.health.healthy" | "owner.health.warning" | "owner.health.critical"> = {
  healthy: "owner.health.healthy",
  warning: "owner.health.warning",
  critical: "owner.health.critical",
};

const LEVEL_CLASS: Record<OwnerHealthStatus["level"], string> = {
  healthy: "border-success/25 bg-success/5",
  warning: "border-warning/25 bg-warning/5",
  critical: "border-danger/25 bg-danger/5",
};

// Always shows its reasons when not healthy, rather than a bare
// color/level — a deliberate UX requirement (and the same shape a
// future alert notifier would read from computeHealthStatus()).
export function OwnerHealthBadge({ status }: { status: OwnerHealthStatus }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${LEVEL_CLASS[status.level]}`}>
      <div className="flex items-center gap-2 text-sm font-bold text-text-primary">
        <span aria-hidden="true">{LEVEL_EMOJI[status.level]}</span>
        {t(LEVEL_LABEL_KEY[status.level])}
      </div>
      {status.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-text-secondary">
          {status.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
