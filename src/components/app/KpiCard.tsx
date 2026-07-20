"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";

type Accent = "purple" | "blue" | "cyan" | "emerald" | "warning";

const ACCENT_ICON_CLASS: Record<Accent, string> = {
  purple: "bg-brand-purple/10 text-brand-purple",
  blue: "bg-brand-blue/10 text-brand-blue",
  cyan: "bg-brand-cyan/10 text-brand-cyan",
  emerald: "bg-brand-emerald/10 text-brand-emerald",
  warning: "bg-warning/10 text-warning",
};

const ACCENT_GLOW_CLASS: Record<Accent, string> = {
  purple: "hover:shadow-[var(--shadow-glow-purple)]",
  blue: "hover:shadow-[var(--shadow-glow-blue)]",
  cyan: "hover:shadow-[var(--shadow-glow-cyan)]",
  emerald: "hover:shadow-[var(--shadow-glow-emerald)]",
  warning: "hover:shadow-[var(--shadow-glow-warning)]",
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
// omitting `percentage` simply doesn't render the second line. Two
// rendering modes, one component, so every stat tile in the app shares
// the same count-up/icon/typography treatment.
export function KpiCard({
  href,
  label,
  value,
  percentage,
  icon,
  accent,
}: {
  href?: string;
  label: string;
  value: number;
  percentage?: number;
  icon: ReactNode;
  accent: Accent;
}) {
  const animatedValue = useCountUp(value);

  const content = (
    <>
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-text-secondary">{label}</p>
        <span
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-300",
            href && "group-hover:scale-110",
            ACCENT_ICON_CLASS[accent]
          )}
        >
          {icon}
        </span>
      </div>
      <div className="mt-4">
        <p className="text-3xl font-bold tabular-nums text-text-primary">
          {animatedValue}
        </p>
        {percentage !== undefined && (
          <p className="mt-1 text-xs text-text-muted">{percentage}% מהפעילות</p>
        )}
      </div>
    </>
  );

  const baseClass = clsx(
    "group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-300 ease-[var(--ease-standard)]"
  );

  if (!href) {
    return <div className={baseClass}>{content}</div>;
  }

  return (
    <Link
      href={href}
      className={clsx(
        baseClass,
        "hover:-translate-y-1 hover:border-transparent",
        ACCENT_GLOW_CLASS[accent]
      )}
    >
      {content}
    </Link>
  );
}
