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

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        <SummaryRow done label={`המשרד "${organization.name}" נוצר`} />
        <SummaryRow done={!!organization.googleConnectedAt} label="Google Drive מחובר" />
        <SummaryRow done={!!organization.whatsappConnectedAt} label="WhatsApp Business מחובר" />
        <SummaryRow
          done={totalClients > 0}
          label={totalClients > 0 ? `${totalClients} לקוחות יובאו` : "טרם יובאו לקוחות"}
        />
        <SummaryRow
          done={classifiedCount > 0}
          label={
            classifiedCount > 0
              ? `${classifiedCount} מתוך ${totalClients} לקוחות סווגו`
              : "טרם סווגו לקוחות"
          }
        />
        <SummaryRow
          done={requirementsConfigured > 0}
          label={
            requirementsConfigured > 0
              ? `${requirementsConfigured} דרישות מסמכים הוגדרו עבור ${businessTypeCount} סוגי עסק`
              : "טרם הוגדרו דרישות מסמכים"
          }
        />
        <SummaryRow done={businessTypeCount > 0} label="כללי תזכורות הוגדרו" />
        <SummaryRow
          done
          label="Centro ילמד באופן שוטף אילו מסמכים כל לקוח שולח, וישפר את איסוף המסמכים העתידי באופן אוטומטי"
        />
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
