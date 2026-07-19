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

export function KpiCard({
  href,
  label,
  value,
  percentage,
  icon,
  accent,
}: {
  href: string;
  label: string;
  value: number;
  percentage: number;
  icon: ReactNode;
  accent: Accent;
}) {
  const animatedValue = useCountUp(value);

  return (
    <Link
      href={href}
      className={clsx(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:-translate-y-1 hover:border-transparent",
        ACCENT_GLOW_CLASS[accent]
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-text-secondary">{label}</p>
        <span
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-300 group-hover:scale-110",
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
        <p className="mt-1 text-xs text-text-muted">{percentage}% מהפעילות</p>
      </div>
    </Link>
  );
}
