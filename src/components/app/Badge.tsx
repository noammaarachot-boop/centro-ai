import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "purple"
  | "blue";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "border-border bg-surface-muted text-text-secondary",
  info: "border-brand-cyan/20 bg-brand-cyan/10 text-brand-cyan",
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/20 bg-warning/10 text-warning",
  danger: "border-danger/20 bg-danger/10 text-danger",
  purple: "border-brand-purple/20 bg-brand-purple/10 text-brand-purple",
  blue: "border-brand-blue/20 bg-brand-blue/10 text-brand-blue",
};

const DOT_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-text-muted",
  info: "bg-brand-cyan",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  purple: "bg-brand-purple",
  blue: "bg-brand-blue",
};

export function Badge({
  tone = "neutral",
  icon: Icon,
  dot = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  icon?: LucideIcon;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className
      )}
    >
      {dot && (
        <span
          className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}
          aria-hidden="true"
        />
      )}
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  );
}
