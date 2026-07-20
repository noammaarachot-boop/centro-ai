import { Wrench } from "lucide-react";

// Wraps pilot-stage debug/simulation tooling (the Settings "run scheduler
// now" button, the collection-request "simulate inbound WhatsApp message"
// panel) that has no real provider/cron behind it yet. Collapsed by
// default, visually distinct (dashed border, muted tone, wrench icon) so
// it reads unambiguously as "not part of the product" rather than sitting
// as a first-class card indistinguishable from real functionality — a
// premium product doesn't surface its own test harness by default. Native
// <details>/<summary> — no new JS, matches the disclosure pattern already
// used elsewhere in the app (e.g. a client's business-type reassignment).
export function DevToolsPanel({
  label = "כלי פיתוח",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-dashed border-border bg-surface-muted/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-xs font-medium text-text-muted transition-colors ease-[var(--ease-standard)] hover:text-text-secondary">
        <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {label}
        <span className="text-text-muted/60">— זמין לבדיקות בלבד, לא חלק מהמוצר</span>
      </summary>
      <div className="space-y-4 border-t border-dashed border-border px-5 py-4">{children}</div>
    </details>
  );
}
