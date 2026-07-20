import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

type GlowTone = "purple" | "blue" | "cyan" | "emerald" | "warning" | "danger";

const GLOW_CLASS: Record<GlowTone, string> = {
  purple: "hover:shadow-[var(--shadow-glow-purple)]",
  blue: "hover:shadow-[var(--shadow-glow-blue)]",
  cyan: "hover:shadow-[var(--shadow-glow-cyan)]",
  emerald: "hover:shadow-[var(--shadow-glow-emerald)]",
  warning: "hover:shadow-[var(--shadow-glow-warning)]",
  danger: "hover:shadow-[var(--shadow-glow-danger)]",
};

export function Card({
  className,
  interactive = false,
  glow,
  padding = "md",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  /** Lifts slightly and deepens its shadow on hover — use for clickable/linked cards. */
  interactive?: boolean;
  /** Adds a soft tinted glow on hover, on top of the interactive elevation. */
  glow?: GlowTone;
  padding?: "none" | "sm" | "md" | "lg";
}) {
  return (
    <div
      className={clsx(
        "rounded-2xl border border-border bg-surface shadow-card transition-all duration-300 ease-[var(--ease-standard)]",
        padding === "sm" && "p-4",
        padding === "md" && "p-6",
        padding === "lg" && "p-8",
        interactive &&
          "hover:-translate-y-0.5 hover:border-brand-purple/25 hover:shadow-card-lg",
        glow && GLOW_CLASS[glow],
        className
      )}
      {...props}
    />
  );
}
