"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { Card } from "@/components/app/Card";
import { Button } from "@/components/app/Button";
import { HelpTip } from "@/components/app/HelpTip";
import { CollectionDayField } from "@/components/app/CollectionDayField";
import { updateServiceScheduleOverrides } from "@/app/onboarding/actions";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

// Shared by the onboarding wizard's Step 7 and a service's own page
// (/services/[id]) — per-Business-Type (i.e. per-Service) reminder
// overrides must "remain editable later from Settings/Services" per Epic
// 3, so both surfaces submit through the same updateServiceScheduleOverrides
// action; only `returnTo` and the heading differ.
export function ServiceScheduleOverrideCard({
  serviceId,
  name,
  hasOverrides,
  businessHoursStart,
  businessHoursEnd,
  businessDays,
  reminderIntervalDays,
  inactivityTimeoutMinutes,
  collectionDayOfMonth,
  returnTo,
}: {
  serviceId: string;
  name: string;
  hasOverrides: boolean;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
  reminderIntervalDays: number;
  inactivityTimeoutMinutes: number;
  collectionDayOfMonth: number;
  returnTo: string;
}) {
  const [useOverrides, setUseOverrides] = useState(hasOverrides);
  const activeDays = new Set(businessDays.split(",").map(Number));
  const action = updateServiceScheduleOverrides.bind(null, serviceId);

  return (
    <Card>
      <form action={action} className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{name}</h3>
          <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <input
              type="checkbox"
              name="useOverrides"
              checked={useOverrides}
              onChange={(e) => setUseOverrides(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-brand-purple"
            />
            התאמה אישית עבור שירות זה
          </label>
        </div>

        <div
          className={clsx(
            "space-y-4 transition-opacity",
            !useOverrides && "pointer-events-none opacity-40"
          )}
        >
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">ימי עבודה</p>
            <div className="flex flex-wrap gap-2">
              {DAY_LABELS.map((label, day) => (
                <label
                  key={day}
                  className="flex items-center gap-1 rounded-lg border border-border bg-surface-muted/40 px-2.5 py-1.5 text-xs text-text-primary"
                >
                  <input
                    type="checkbox"
                    name={`day-${day}`}
                    defaultChecked={activeDays.has(day)}
                    disabled={!useOverrides}
                    className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                שעת התחלה
              </label>
              <input
                name="businessHoursStart"
                type="time"
                defaultValue={businessHoursStart}
                disabled={!useOverrides}
                dir="ltr"
                className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                שעת סיום
              </label>
              <input
                name="businessHoursEnd"
                type="time"
                defaultValue={businessHoursEnd}
                disabled={!useOverrides}
                dir="ltr"
                className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary">
                מרווח תזכורות (ימים)
                <span className="pointer-events-auto">
                  <HelpTip label="">
                    אם הלקוח לא הגיב, Centro ישלח תזכורת נוספת אוטומטית כל X ימים.
                  </HelpTip>
                </span>
              </label>
              <input
                name="reminderIntervalDays"
                type="number"
                min={1}
                defaultValue={reminderIntervalDays}
                disabled={!useOverrides}
                className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary">
                זמן חוסר פעילות (דקות)
                <span className="pointer-events-auto">
                  <HelpTip label="">
                    אם הלקוח מפסיק לשלוח מסמכים למשך כך הרבה דקות, Centro מניח שסיים בינתיים
                    ושואל אם יש מסמכים נוספים.
                  </HelpTip>
                </span>
              </label>
              <input
                name="inactivityTimeoutMinutes"
                type="number"
                min={1}
                defaultValue={inactivityTimeoutMinutes}
                disabled={!useOverrides}
                className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
            </div>
          </div>

          <CollectionDayField
            defaultValue={collectionDayOfMonth}
            disabled={!useOverrides}
            size="sm"
            helpText="היום בחודש שבו Centro מתחיל לבקש מסמכים עבור סוג עסק זה. זו מדיניות משרד — Centro לעולם לא ילמד או ישנה אותה אוטומטית."
          />
        </div>

        <input type="hidden" name="returnTo" value={returnTo} />
        <Button type="submit" variant="secondary" size="sm">
          שמירה
        </Button>
      </form>
    </Card>
  );
}
