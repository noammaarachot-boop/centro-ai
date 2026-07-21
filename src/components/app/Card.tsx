import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

type GlowTone = "purple" | "blue" | "cyan" | "emerald" | "warning" | "danger";

// Centro Glow — a card's colored glow now lives behind it (a blurred
// pseudo-element, `.centro-live-card` in globals.css), not as a bright
// box-shadow directly on the card's own edge. `cyan` keeps its existing
// prop name for backward compatibility with every call site; it maps to
// the "teal" glow class internally.
const GLOW_CLASS: Record<GlowTone, string> = {
  purple: "centro-glow-purple",
  blue: "centro-glow-blue",
  cyan: "centro-glow-teal",
  emerald: "centro-glow-emerald",
  warning: "centro-glow-warning",
  danger: "centro-glow-danger",
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
  /** Adds a soft tinted glow behind the card on hover, on top of the interactive elevation. */
  glow?: GlowTone;
  padding?: "none" | "sm" | "md" | "lg";
}) {
  return (
    <div
      className={clsx(
        "centro-glass rounded-2xl border border-border shadow-card transition-all duration-300 ease-[var(--ease-standard)]",
        padding === "sm" && "p-4",
        padding === "md" && "p-6",
        padding === "lg" && "p-8",
        interactive &&
          "hover:-translate-y-0.5 hover:border-brand-purple/25 hover:shadow-card-lg",
        glow && ["centro-live-card", GLOW_CLASS[glow]],
        className
      )}
      {...props}
    />
  );
}
