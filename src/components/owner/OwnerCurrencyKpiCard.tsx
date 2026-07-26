import type { ReactNode } from "react";
import { clsx } from "clsx";

type Accent = "purple" | "blue" | "cyan" | "emerald" | "warning";

const ACCENT_ICON_CLASS: Record<Accent, string> = {
  purple: "centro-icon-purple",
  blue: "centro-icon-blue",
  cyan: "centro-icon-teal",
  emerald: "centro-icon-emerald",
  warning: "centro-icon-warning",
};

// KpiCard (src/components/app/KpiCard.tsx) animates its value via
// useCountUp, which always displays Math.round(value) — fine for plain
// counts, but it would round a dollar estimate like $0.0034 down to
// "0" and lose all meaning. This mirrors KpiCard's visual structure for
// a pre-formatted currency string instead, with no animation.
export function OwnerCurrencyKpiCard({
  label,
  formattedValue,
  icon,
  accent,
  approximate,
}: {
  label: string;
  formattedValue: string;
  icon: ReactNode;
  accent: Accent;
  approximate?: boolean;
}) {
  return (
    <div className="centro-glass flex flex-col justify-between rounded-2xl border border-border p-5 shadow-card">
      <div className="flex items-start justify-between">
        <p className="text-sm font-semibold text-text-secondary">{label}</p>
        <span
          className={clsx(
            "grid h-[33px] w-[33px] shrink-0 place-items-center rounded-xl",
            ACCENT_ICON_CLASS[accent]
          )}
        >
          {icon}
        </span>
      </div>
      <div className="mt-4">
        <p className="text-2xl font-bold tabular-nums text-text-primary" dir="ltr">
          {approximate ? "~" : ""}
          {formattedValue}
        </p>
      </div>
    </div>
  );
}
