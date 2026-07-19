import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { AlarmClock } from "lucide-react";
import { resolveScheduleConfig } from "@/lib/businessHours";
import { advanceOnboardingStep } from "../actions";
import { ServiceScheduleOverrideCard } from "@/components/app/ServiceScheduleOverrideCard";

interface ServiceRow {
  id: string;
  businessHoursStartOverride: string | null;
  businessHoursEndOverride: string | null;
  businessDaysOverride: string | null;
  reminderIntervalDaysOverride: number | null;
  inactivityTimeoutMinutesOverride: number | null;
}

interface OrganizationDefaults {
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
  reminderIntervalDays: number;
  inactivityTimeoutMinutes: number;
}

export function Step7Reminders({
  entries,
  organization,
}: {
  entries: Array<{ businessType: { id: string; name: string }; service: ServiceRow | null }>;
  organization: OrganizationDefaults;
}) {
  const goToStep8 = advanceOnboardingStep.bind(null, 8);

  return (
    <div className="space-y-5">
      {entries.length === 0 ? (
        <EmptyState
          icon={AlarmClock}
          title="עדיין אין סוגי עסק"
          description="ברירת המחדל של המשרד (מוגדרת בהגדרות) תחול על כל בקשות האיסוף עד שיוגדרו סוגי עסק."
        />
      ) : (
        entries.map(({ businessType, service }) => {
          const hasOverrides = !!(
            service?.businessHoursStartOverride ||
            service?.businessHoursEndOverride ||
            service?.businessDaysOverride ||
            service?.reminderIntervalDaysOverride ||
            service?.inactivityTimeoutMinutesOverride
          );
          const effective = resolveScheduleConfig(organization, service);
          return (
            <ServiceScheduleOverrideCard
              key={businessType.id}
              serviceId={service!.id}
              name={businessType.name}
              hasOverrides={hasOverrides}
              businessHoursStart={effective.businessHoursStart}
              businessHoursEnd={effective.businessHoursEnd}
              businessDays={effective.businessDays}
              reminderIntervalDays={effective.reminderIntervalDays}
              inactivityTimeoutMinutes={effective.inactivityTimeoutMinutes}
              returnTo="/onboarding?step=7"
            />
          );
        })
      )}

      <form action={goToStep8}>
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
