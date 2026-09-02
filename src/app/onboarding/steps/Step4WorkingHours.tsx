import { BusinessHoursForm } from "@/components/app/BusinessHoursForm";
import { updateOnboardingWorkingHours } from "../actions";

// Onboarding's business-hours step.
//
// Renders the EXACT component /settings uses, against the exact same
// organizations columns — so whatever is chosen here is literally what
// Settings shows afterwards, and editing it there later keeps working
// unchanged. Only the submit action differs (it also advances the wizard),
// which is why BusinessHoursForm takes it as a prop.
//
// Every default shown comes from the organization row itself, i.e. from
// the schema defaults (א׳–ה׳, 09:00–18:00, Asia/Jerusalem, and a reminder
// interval of 5 hours) — this step introduces no defaults of its own.
export function Step4WorkingHours({
  organization,
}: {
  organization: {
    businessDays: string;
    businessHoursStart: string;
    businessHoursEnd: string;
    timezone: string;
    reminderIntervalHours: number;
    humanReviewAfterDays: number;
  };
}) {
  return (
    <BusinessHoursForm
      organization={organization}
      action={updateOnboardingWorkingHours}
      submitLabel="המשך"
      pendingLabel="שומר…"
      // A wizard step must stay submittable when the user simply accepts
      // the defaults, unlike Settings' save-only-when-changed button.
      requireDirty={false}
      // The step navigates away on success — nothing to confirm in place.
      showSuccessMessage={false}
    />
  );
}
