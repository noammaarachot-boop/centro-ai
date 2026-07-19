import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { updateBusinessHours } from "./actions";
import { RunSchedulerButton } from "./RunSchedulerButton";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export default async function SettingsPage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  const activeDays = new Set(organization.businessDays.split(",").map(Number));

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        title="הגדרות"
        description="שעות פעילות וימי עבודה קובעים מתי Centro שולח הודעות אוטומטיות (BR-18.1)."
      />

      <form action={updateBusinessHours}>
        <Card className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-medium text-text-secondary">ימי עבודה</p>
            <div className="flex flex-wrap gap-3">
              {DAY_LABELS.map((label, day) => (
                <label
                  key={day}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-muted/40 px-3 py-1.5 text-sm text-text-primary transition-colors hover:border-brand-purple/30"
                >
                  <input
                    type="checkbox"
                    name={`day-${day}`}
                    defaultChecked={activeDays.has(day)}
                    className="h-4 w-4 rounded border-border accent-brand-purple"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="businessHoursStart"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                שעת התחלה
              </label>
              <input
                id="businessHoursStart"
                name="businessHoursStart"
                type="time"
                defaultValue={organization.businessHoursStart}
                dir="ltr"
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
            <div>
              <label
                htmlFor="businessHoursEnd"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                שעת סיום
              </label>
              <input
                id="businessHoursEnd"
                name="businessHoursEnd"
                type="time"
                defaultValue={organization.businessHoursEnd}
                dir="ltr"
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="reminderIntervalDays"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                מרווח תזכורות (ימים)
              </label>
              <input
                id="reminderIntervalDays"
                name="reminderIntervalDays"
                type="number"
                min={1}
                defaultValue={organization.reminderIntervalDays}
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
            <div>
              <label
                htmlFor="inactivityTimeoutMinutes"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                זמן חוסר פעילות (דקות)
              </label>
              <input
                id="inactivityTimeoutMinutes"
                name="inactivityTimeoutMinutes"
                type="number"
                min={1}
                defaultValue={organization.inactivityTimeoutMinutes}
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
          </div>

          <button type="submit" className={buttonVariants({ variant: "primary", size: "lg" })}>
            שמירת הגדרות
          </button>
        </Card>
      </form>

      <RunSchedulerButton />
    </div>
  );
}
