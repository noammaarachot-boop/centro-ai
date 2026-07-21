"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";

type Accent = "purple" | "blue" | "cyan" | "emerald" | "warning";

// Centro Glow — icon badges are a soft two-stop gradient + a small
// colored shadow (never a flat tint), and the card's own hover glow
// lives behind it (`.centro-live-card`'s ::after), matched to the same
// accent, instead of a bright box-shadow directly on the card.
const ACCENT_ICON_CLASS: Record<Accent, string> = {
  purple: "centro-icon-purple",
  blue: "centro-icon-blue",
  cyan: "centro-icon-teal",
  emerald: "centro-icon-emerald",
  warning: "centro-icon-warning",
};

const ACCENT_GLOW_CLASS: Record<Accent, string> = {
  purple: "centro-glow-purple",
  blue: "centro-glow-blue",
  cyan: "centro-glow-teal",
  emerald: "centro-glow-emerald",
  warning: "centro-glow-warning",
};

function useCountUp(target: number, durationMs = 700) {
  const [value, setValue] = useState(0);
  const startRef = useRef<number | null>(null);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reducedMotion) return;

    let frame: number;
    const step = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp;
      const progress = Math.min((timestamp - startRef.current) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reducedMotion]);

  return reducedMotion ? target : value;
}

// The one stat-tile primitive for the whole app — absorbs what used to be
// OneTimeDashboard's separate, non-animated, non-linked local `StatTile`.
// Omitting `href` renders a plain (non-interactive, non-glowing) tile;
// omitting `percentage` simply doesn't render the second line.
// `variant="primary"` is the single, larger "needs you most" tile a
// dashboard puts beside its calm KpiCard grid (Centro Glow's approved
// two-tier hierarchy) — same component, just more visual weight and an
// optional `sub` caption in place of the percentage line.
export function KpiCard({
  href,
  label,
  value,
  percentage,
  icon,
  accent,
  variant = "default",
  sub,
}: {
  href?: string;
  label: string;
  value: number;
  percentage?: number;
  icon: ReactNode;
  accent: Accent;
  variant?: "default" | "primary";
  sub?: string;
}) {
  const animatedValue = useCountUp(value);
  const isPrimary = variant === "primary";

  const content = (
    <>
      <div className="flex items-start justify-between">
        <p className="text-sm font-semibold text-text-secondary">{label}</p>
        <span
          className={clsx(
            "grid shrink-0 place-items-center rounded-xl transition-transform duration-300 ease-[var(--ease-standard)]",
            isPrimary ? "h-10 w-10" : "h-[33px] w-[33px]",
            href && "group-hover:scale-110",
            ACCENT_ICON_CLASS[accent]
          )}
        >
          {icon}
        </span>
      </div>
      <div className={isPrimary ? "mt-5" : "mt-4"}>
        <p
          className={clsx(
            "font-bold tabular-nums text-text-primary",
            isPrimary ? "text-[52px] leading-none tracking-tight" : "text-2xl"
          )}
        >
          {animatedValue}
        </p>
        {isPrimary && sub ? (
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">{sub}</p>
        ) : (
          percentage !== undefined && (
            <p className="mt-1 text-xs text-text-muted">{percentage}% מהפעילות</p>
          )
        )}
      </div>
    </>
  );

  const baseClass = clsx(
    "group relative flex flex-col justify-between rounded-2xl border border-border shadow-card transition-all duration-300 ease-[var(--ease-standard)]",
    isPrimary ? "centro-glass-strong p-7" : "centro-glass p-5"
  );

  if (!href) {
    return <div className={baseClass}>{content}</div>;
  }

  return (
    <Link
      href={href}
      className={clsx(baseClass, "centro-live-card hover:-translate-y-1", ACCENT_GLOW_CLASS[accent])}
    >
      {content}
    </Link>
  );
}
