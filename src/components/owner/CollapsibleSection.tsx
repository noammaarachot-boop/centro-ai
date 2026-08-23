import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

// One consistent way to fold an area away across the whole owner console.
// Built on <details>/<summary> deliberately: it needs no client JavaScript,
// keeps working in a server component, and is keyboard- and
// screen-reader-accessible for free.
export function CollapsibleSection({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Optional status shown on the closed row, so the fold still tells you something. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-2xl border border-border bg-surface-muted/40 transition-colors open:bg-transparent"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5">
        <ChevronDown
          className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-text-primary">{title}</span>
          {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
        </div>
        {badge && <span className="shrink-0">{badge}</span>}
      </summary>
      <div className="border-t border-border px-5 py-4">{children}</div>
    </details>
  );
}
