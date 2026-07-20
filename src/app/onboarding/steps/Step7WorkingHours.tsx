import { buttonVariants } from "@/components/app/Button";
import { updateWorkingHours } from "../actions";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

// Workflow B's own Step 7 — business days/hours only, never reminder
// cadence (see updateWorkingHours's comment). Same field shape as
// Settings' org-wide default form, deliberately not reused directly since
// that form's own submit/copy is tailored to a post-onboarding settings
// page, not a wizard step with a "continue" action.
export function Step7WorkingHours({
  businessHoursStart,
  businessHoursEnd,
  businessDays,
}: {
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
}) {
  const activeDays = new Set(businessDays.split(",").map(Number));

  return (
    <form action={updateWorkingHours} className="space-y-5">
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
            defaultValue={businessHoursStart}
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
            defaultValue={businessHoursEnd}
            dir="ltr"
            className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
        </div>
      </div>

      <button
        type="submit"
        className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
      >
        המשך
      </button>
    </form>
  );
}
