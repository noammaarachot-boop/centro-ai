"use client";

import { useId, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { clsx } from "clsx";

// Reusable "Why is this important?" popover — every onboarding wizard step
// uses this, and it's placed here (not under app/onboarding) so any future
// step, settings section, or feature can reuse the same pattern.
export function HelpTip({
  label = "למה זה חשוב?",
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();

  return (
    <div className={clsx("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={popoverId}
        className="inline-flex items-center gap-1.5 rounded-full text-xs font-medium text-brand-purple transition-colors hover:text-brand-purple-deep focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {label}
      </button>

      {open && (
        <div
          id={popoverId}
          role="tooltip"
          className="centro-glass-strong animate-fade-in-up absolute z-20 mt-2 w-64 rounded-2xl border border-border p-4 text-start shadow-card-lg start-0"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירה"
            className="absolute end-2 top-2 grid h-6 w-6 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="pe-5 text-xs leading-relaxed text-text-secondary">{children}</p>
        </div>
      )}
    </div>
  );
}
