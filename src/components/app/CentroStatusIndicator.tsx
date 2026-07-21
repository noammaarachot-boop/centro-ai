// Dashboard-only — a quiet signal that Centro is continuously watching
// the business, not a functional control. Server Component: the
// tooltip is pure CSS (:hover/:focus-within), no client state needed.
export function CentroStatusIndicator() {
  return (
    <div className="centro-glass group relative inline-flex shrink-0 items-center gap-2 rounded-full border border-border py-[7px] ps-[10px] pe-[13px]">
      <span className="relative h-[9px] w-[9px] shrink-0">
        <span className="centro-status-dot absolute inset-0 rounded-full bg-brand-emerald" />
      </span>
      <span className="text-xs font-bold text-text-secondary">סנטרו פעיל</span>
      <div
        role="tooltip"
        className="pointer-events-none absolute left-0 top-[calc(100%+9px)] z-10 w-[230px] -translate-y-1 rounded-[10px] bg-text-primary px-3 py-[9px] text-[11.5px] leading-[1.5] text-[#f1eefb] opacity-0 shadow-card-lg transition-all duration-200 ease-[var(--ease-standard)] group-hover:translate-y-0 group-hover:opacity-100"
      >
        סנטרו עוקב באופן רציף אחר העסק שלך.
      </div>
    </div>
  );
}
