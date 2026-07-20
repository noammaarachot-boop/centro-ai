"use client";

import { clsx } from "clsx";

export interface TabItem {
  value: string;
  label: string;
}

// Shared pill-tab switcher — replaces the near-identical local
// role="tablist" implementations hand-rolled in AuthTabs.tsx and
// TemplateClientAssignment.tsx. Purely a controlled presentational
// component: the caller owns the active-tab state and what renders below.
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 rounded-full border border-border bg-surface-muted p-1"
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={clsx(
            "flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors ease-[var(--ease-standard)]",
            value === item.value
              ? "bg-white text-text-primary shadow-card"
              : "text-text-muted hover:text-text-primary"
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
