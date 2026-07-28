import { Clock } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { advanceOnboardingStep } from "../actions";

interface OrganizationSummary {
  name: string;
}

const ROW_STAGGER_MS = 900;
const ROW_START_MS = 100;

// Each row fades in in turn; a `done` row's checkmark draws in and the
// row briefly highlights at the same moment (see .centro-summary-row* in
// globals.css). Every row here is framed as either done or deliberately
// optional/deferred — never as an incomplete "todo" — so there is no
// red-X state in this version (see the "First-Send Journey" comment
// below for why Google Drive/WhatsApp specifically moved from a done/not-
// done row to a plain deferred note).
function SummaryRow({ label, index }: { label: string; index: number }) {
  const delayMs = ROW_START_MS + index * ROW_STAGGER_MS;
  const rowStyle = { "--row-delay": `${delayMs}ms` } as React.CSSProperties;
  return (
    <li
      className="centro-summary-row centro-summary-row-highlight flex items-center gap-2.5 rounded-xl border border-border bg-surface-muted/40 px-4 py-3"
      style={rowStyle}
    >
      <AnimatedCheckBadge size={20} delayMs={delayMs} className="shrink-0" />
      <span className="text-sm text-text-primary">{label}</span>
    </li>
  );
}

// Workflow B's own Step 7 (was Step 8 before the First-Send Journey
// rework removed Connect from this flow — see onboarding/page.tsx's
// RECURRING_STEP_META comment) — deliberately different checklist than
// the recurring path's Step8Summary: no classification/document/reminder
// items, since none of those exist in this workflow. Client import is
// framed as optional throughout, matching Step 5's own "skip or import
// later" copy — never marked incomplete for being empty.
//
// First-Send Journey — Google Drive/WhatsApp are no longer connected
// during onboarding at all in this flow (moved into the Collection
// Requests wizard's own Connect step, right before the first send), so
// this summary no longer claims they're "connected" or not — it says
// plainly when that happens instead.
export function Step8OneTimeSummary({
  organization,
  totalClients,
}: {
  organization: OrganizationSummary;
  totalClients: number;
}) {
  const goToNext = advanceOnboardingStep.bind(null, 8);

  const rows: string[] = [
    `העסק "${organization.name}" נוצר`,
    totalClients > 0 ? `${totalClients} לקוחות יובאו` : "לא יובאו לקוחות עדיין — אפשר תמיד להוסיף מאוחר יותר",
    "שעות פעילות הוגדרו",
  ];
  const deferredDelayMs = ROW_START_MS + rows.length * ROW_STAGGER_MS;
  const continueDelayMs = deferredDelayMs + ROW_STAGGER_MS;

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        {rows.map((label, index) => (
          <SummaryRow key={index} label={label} index={index} />
        ))}
        <li
          className="centro-summary-row flex items-center gap-2.5 rounded-xl border border-dashed border-border bg-surface-muted/20 px-4 py-3"
          style={{ "--row-delay": `${deferredDelayMs}ms` } as React.CSSProperties}
        >
          <Clock className="h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="text-sm text-text-muted">
            Google Drive ו-WhatsApp יחוברו בשלב הראשון של יצירת בקשת האיסוף הראשונה שלכם
          </span>
        </li>
      </ul>

      <form
        action={goToNext}
        className="centro-summary-continue"
        style={{ "--continue-delay": `${continueDelayMs}ms` } as React.CSSProperties}
      >
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </button>
      </form>
    </div>
  );
}
