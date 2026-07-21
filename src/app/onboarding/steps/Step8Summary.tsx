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

export function Step8Summary({
  organization,
  totalClients,
  classifiedCount,
  businessTypeCount,
  requirementsConfigured,
}: {
  organization: OrganizationSummary;
  totalClients: number;
  classifiedCount: number;
  businessTypeCount: number;
  requirementsConfigured: number;
}) {
  const goToStep9 = advanceOnboardingStep.bind(null, 11);

  const rows: { done: boolean; label: string }[] = [
    { done: true, label: `העסק "${organization.name}" נוצר` },
    { done: !!organization.googleConnectedAt, label: "Google Drive מחובר" },
    { done: !!organization.whatsappConnectedAt, label: "WhatsApp Business מחובר" },
    {
      done: totalClients > 0,
      label: totalClients > 0 ? `${totalClients} לקוחות יובאו` : "טרם יובאו לקוחות",
    },
    {
      done: classifiedCount > 0,
      label:
        classifiedCount > 0
          ? `${classifiedCount} מתוך ${totalClients} לקוחות סווגו`
          : "טרם סווגו לקוחות",
    },
    {
      done: requirementsConfigured > 0,
      label:
        requirementsConfigured > 0
          ? `${requirementsConfigured} דרישות מסמכים הוגדרו עבור ${businessTypeCount} סוגי עסק`
          : "טרם הוגדרו דרישות מסמכים",
    },
    { done: businessTypeCount > 0, label: "כללי תזכורות הוגדרו" },
    {
      done: true,
      label:
        "Centro ילמד באופן שוטף אילו מסמכים כל לקוח שולח, וישפר את איסוף המסמכים העתידי באופן אוטומטי",
    },
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
