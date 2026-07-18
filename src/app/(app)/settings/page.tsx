import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { updateBusinessHours } from "./actions";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export default async function SettingsPage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  const activeDays = new Set(organization.businessDays.split(",").map(Number));

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="mb-1 text-2xl font-semibold text-text-primary">הגדרות</h1>
      <p className="mb-6 text-sm text-text-secondary">
        שעות פעילות וימי עבודה קובעים מתי Centro שולח הודעות אוטומטיות
        (BR-18.1).
      </p>

      <form
        action={updateBusinessHours}
        className="space-y-5 rounded-2xl border border-border bg-surface p-6 shadow-card"
      >
        <div>
          <p className="mb-2 text-sm font-medium text-text-secondary">ימי עבודה</p>
          <div className="flex flex-wrap gap-3">
            {DAY_LABELS.map((label, day) => (
              <label
                key={day}
                className="flex items-center gap-1.5 text-sm text-text-primary"
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
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
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
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
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
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
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
              className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
            />
          </div>
        </div>

        <button
          type="submit"
          className="rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-3 text-sm font-semibold text-white shadow-card-lg"
        >
          שמירת הגדרות
        </button>
      </form>
    </div>
  );
}
