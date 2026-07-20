import { CheckCircle2, Circle } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { advanceOnboardingStep } from "../actions";

interface OrganizationSummary {
  name: string;
  googleConnectedAt: Date | null;
  whatsappConnectedAt: Date | null;
}

function SummaryRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-muted/40 px-4 py-3">
      {done ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-emerald" />
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

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        <SummaryRow done label={`המשרד "${organization.name}" נוצר`} />
        <SummaryRow done={!!organization.googleConnectedAt} label="Google Drive מחובר" />
        <SummaryRow done={!!organization.whatsappConnectedAt} label="WhatsApp Business מחובר" />
        <SummaryRow
          done={totalClients > 0}
          label={
            totalClients > 0
              ? `${totalClients} לקוחות יובאו`
              : "לא יובאו לקוחות עדיין — אפשר תמיד להוסיף מאוחר יותר"
          }
        />
        <SummaryRow done label="שעות פעילות הוגדרו" />
      </ul>

      <form action={goToStep9}>
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
