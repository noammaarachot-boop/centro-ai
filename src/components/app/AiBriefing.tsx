import Link from "next/link";

// Centro Glow's hero module — a rule-based headline composed purely from
// counts the dashboard already queries (see buildBriefing() in each
// dashboard's page component) — no live AI/LLM call, no new data
// dependency. Manifesto Part 9: "know the business in 5 seconds," now the
// dashboard's primary module rather than a small banner above the grid.
//
// `actions` (optional) surfaces the same "needs attention" items the
// headline already summarizes in prose as individually clickable chips —
// every href here already exists elsewhere on the page (the KpiCard grid
// links to the identical queue); this is a shortcut duplicating existing
// navigation, not a new capability.
//
// Deliberately has no logo/glyph inside it — the Centro mark lives only in
// the Sidebar, per the approved design review.
export interface AiBriefingAction {
  href: string;
  label: string;
  count: number;
}

export function AiBriefing({
  text,
  actions,
}: {
  text: string;
  actions?: AiBriefingAction[];
}) {
  return (
    <div className="centro-glass-strong relative mb-8 overflow-hidden rounded-[24px] border border-border p-8 shadow-card-lg sm:p-9">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-[6%] -inset-y-[22%] -z-10 blur-[24px]"
        style={{
          background:
            "radial-gradient(55% 90% at 15% 30%, color-mix(in oklab, var(--color-brand-purple) 16%, transparent), transparent 72%), radial-gradient(40% 70% at 85% 80%, color-mix(in oklab, var(--color-brand-cyan) 11%, transparent), transparent 74%)",
        }}
      />
      <p className="centro-ai-gradient-text mb-2.5 text-[11.5px] font-bold tracking-[0.13em] uppercase">
        תדרוך Centro
      </p>
      <h1 className="max-w-[58ch] text-xl leading-relaxed font-bold text-text-primary sm:text-[23px]">
        {text}
      </h1>
      {actions && actions.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2.5">
          {actions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="inline-flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2.5 text-[13.5px] font-semibold text-text-primary shadow-card transition-all duration-200 ease-[var(--ease-standard)] hover:-translate-y-0.5 hover:border-brand-purple/35 hover:shadow-[0_14px_28px_-14px_rgba(124,58,237,0.32)]"
            >
              <span className="centro-ai-gradient inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-extrabold text-white">
                {action.count}
              </span>
              {action.label}
              <span className="text-text-muted" aria-hidden="true">
                ←
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
