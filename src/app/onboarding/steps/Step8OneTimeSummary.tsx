import { Circle } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { advanceOnboardingStep } from "../actions";

interface OrganizationSummary {
  name: string;
  googleConnectedAt: Date | null;
  whatsappConnectedAt: Date | null;
}

const ROW_STAGGER_MS = 900;
const ROW_START_MS = 100;

// Each row fades in in turn; a `done` row's checkmark draws in and the
// row briefly highlights at the same moment (see .centro-summary-row* in
// globals.css) — an incomplete row just fades in with its hollow circle,
// nothing to "complete" yet.
function SummaryRow({ done, label, index }: { done: boolean; label: string; index: number }) {
  const delayMs = ROW_START_MS + index * ROW_STAGGER_MS;
  const rowStyle = { "--row-delay": `${delayMs}ms` } as React.CSSProperties;
  return (
    <li
      className={`centro-summary-row${done ? " centro-summary-row-highlight" : ""} flex items-center gap-2.5 rounded-xl border border-border bg-surface-muted/40 px-4 py-3`}
      style={rowStyle}
    >
      {done ? (
        <AnimatedCheckBadge size={20} delayMs={delayMs} className="shrink-0" />
      ) : (
        <Circle className="h-5 w-5 shrink-0 text-text-muted" />
      )}
      <span className={done ? "text-sm text-text-primary" : "text-sm text-text-muted"}>
        {label}
      </span>
    </li>
  );
}

// Workflow B's own Step 8 — deliberately different checklist than the
// recurring path's Step8Summary: no classification/document/reminder
// items, since none of those exist in this workflow. Client import is
// framed as optional throughout (never "todo"), matching Step 6's own
// "skip or import later" copy.
export function Step8OneTimeSummary({
  organization,
  totalClients,
}: {
  organization: OrganizationSummary;
  totalClients: number;
}) {
  const goToStep9 = advanceOnboardingStep.bind(null, 9);

  const rows: { done: boolean; label: string }[] = [
    { done: true, label: `העסק "${organization.name}" נוצר` },
    { done: !!organization.googleConnectedAt, label: "Google Drive מחובר" },
    { done: !!organization.whatsappConnectedAt, label: "WhatsApp Business מחובר" },
    {
      done: totalClients > 0,
      label:
        totalClients > 0
          ? `${totalClients} לקוחות יובאו`
          : "לא יובאו לקוחות עדיין — אפשר תמיד להוסיף מאוחר יותר",
    },
    { done: true, label: "שעות פעילות הוגדרו" },
  ];
  const continueDelayMs = ROW_START_MS + rows.length * ROW_STAGGER_MS;

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <SummaryRow key={index} done={row.done} label={row.label} index={index} />
        ))}
      </ul>

      <form
        action={goToStep9}
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
