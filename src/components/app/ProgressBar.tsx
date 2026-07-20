import { clsx } from "clsx";

// Replaces the hand-built progress-bar markup duplicated in the dashboard's
// queue tables. `showLabel` renders the percentage as trailing text using
// the same typography the original inline markup used.
export function ProgressBar({
  percent,
  showLabel = false,
  className,
}: {
  percent: number;
  showLabel?: boolean;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={clsx("flex items-center gap-2", className)}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full bg-gradient-to-l from-brand-emerald to-brand-cyan transition-all duration-500 ease-[var(--ease-standard)]"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && <span className="text-text-secondary">{clamped}%</span>}
    </div>
  );
}
