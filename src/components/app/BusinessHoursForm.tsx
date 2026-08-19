"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/app/Button";
import { HelpTip } from "@/components/app/HelpTip";
import { fieldClass } from "@/components/app/FormField";
import { SUPPORTED_TIMEZONES } from "@/lib/businessHours";
import { updateBusinessHours, type SettingsFormState } from "@/app/(app)/settings/actions";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const initialState: SettingsFormState = {};

interface FormValues {
  days: number[]; // sorted, e.g. [0,1,2,3,4]
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  timezone: string;
  reminderIntervalHours: number;
}

function sortedDays(days: Iterable<number>): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

function valuesEqual(a: FormValues, b: FormValues): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.timezone === b.timezone &&
    a.reminderIntervalHours === b.reminderIntervalHours &&
    a.days.length === b.days.length &&
    a.days.every((d, i) => d === b.days[i])
  );
}

// Real-time mirror of updateBusinessHours' own server-side checks (settings/actions.ts)
// — every rule appears in exactly one place in prose (there, as the actual
// validation); this only re-derives the same four conditions so an invalid
// value never even reaches a round trip. The server keeps validating too
// (never trust the client) — this is a UX improvement, not a second source
// of truth for what "valid" means.
function computeErrors(values: FormValues): { days?: string; hours?: string; reminder?: string } {
  const errors: { days?: string; hours?: string; reminder?: string } = {};
  if (values.days.length === 0) errors.days = "יש לבחור לפחות יום עבודה אחד.";
  if (values.start >= values.end) errors.hours = "שעת הסיום חייבת להיות מאוחרת משעת ההתחלה.";
  if (!Number.isInteger(values.reminderIntervalHours) || values.reminderIntervalHours < 1 || values.reminderIntervalHours > 24) {
    errors.reminder = "מרווח התזכורות חייב להיות בין 1 ל-24 שעות.";
  }
  return errors;
}

// Dirty-state save flow for the business-hours/timezone/reminder-interval
// card: Save stays disabled until something actually changed (and stays
// disabled again if the change makes the form invalid), shows "שומר…"
// while the server action is in flight (native form-submission double-
// click protection comes from the same `pending` disabling the button),
// and only shows the green confirmation once the server action has
// actually returned success — never optimistically. An error leaves every
// field exactly as the user typed it (all inputs are controlled by
// `values`, never reset to `defaultValue`).
export function BusinessHoursForm({
  organization,
}: {
  organization: {
    businessDays: string;
    businessHoursStart: string;
    businessHoursEnd: string;
    timezone: string;
    reminderIntervalHours: number;
  };
}) {
  const [state, formAction, isPending] = useActionState(updateBusinessHours, initialState);

  const persisted = useMemo<FormValues>(
    () => ({
      days: sortedDays(organization.businessDays.split(",").map(Number)),
      start: organization.businessHoursStart,
      end: organization.businessHoursEnd,
      timezone: organization.timezone,
      reminderIntervalHours: organization.reminderIntervalHours,
    }),
    [organization.businessDays, organization.businessHoursStart, organization.businessHoursEnd, organization.timezone, organization.reminderIntervalHours]
  );

  const [savedValues, setSavedValues] = useState(persisted);
  const [values, setValues] = useState(persisted);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const pendingSubmitValuesRef = useRef(values);
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    if (!state.error) {
      setSavedValues(pendingSubmitValuesRef.current);
      setJustSucceeded(true);
    }
  }, [state]);

  const isDirty = !valuesEqual(values, savedValues);
  const clientErrors = computeErrors(values);
  const hasClientErrors = Object.keys(clientErrors).length > 0;
  const showSuccess = justSucceeded && !isDirty;

  function toggleDay(day: number) {
    setValues((v) => ({
      ...v,
      days: v.days.includes(day) ? v.days.filter((d) => d !== day) : sortedDays([...v.days, day]),
    }));
  }

  return (
    <form
      action={formAction}
      onSubmit={() => {
        pendingSubmitValuesRef.current = values;
      }}
      className="space-y-5"
    >
      <div>
        <p className="mb-2 text-sm font-medium text-text-secondary">ימי עבודה</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="ימי עבודה">
          {DAY_LABELS.map((label, day) => {
            const active = values.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={active}
                onClick={() => toggleDay(day)}
                className={clsx(
                  "h-10 w-10 rounded-full border text-sm font-semibold transition-colors",
                  active
                    ? "border-brand-purple bg-brand-purple text-white shadow-card"
                    : "border-border bg-surface-muted/40 text-text-secondary hover:border-brand-purple/40 hover:text-brand-purple"
                )}
              >
                {label}
              </button>
            );
          })}
          {DAY_LABELS.map((_, day) => (
            <input key={day} type="hidden" name={`day-${day}`} value={values.days.includes(day) ? "on" : ""} />
          ))}
        </div>
        {clientErrors.days && <p className="mt-1.5 text-xs font-medium text-danger">{clientErrors.days}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="businessHoursStart" className="mb-1.5 block text-sm font-medium text-text-secondary">
            שעת התחלה
          </label>
          <input
            id="businessHoursStart"
            name="businessHoursStart"
            type="time"
            value={values.start}
            onChange={(e) => setValues((v) => ({ ...v, start: e.target.value }))}
            dir="ltr"
            className={fieldClass("md")}
          />
        </div>
        <div>
          <label htmlFor="businessHoursEnd" className="mb-1.5 block text-sm font-medium text-text-secondary">
            שעת סיום
          </label>
          <input
            id="businessHoursEnd"
            name="businessHoursEnd"
            type="time"
            value={values.end}
            onChange={(e) => setValues((v) => ({ ...v, end: e.target.value }))}
            dir="ltr"
            className={fieldClass("md")}
          />
        </div>
      </div>
      {clientErrors.hours && <p className="-mt-3 text-xs font-medium text-danger">{clientErrors.hours}</p>}

      <div>
        <label htmlFor="timezone" className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary">
          אזור זמן
          <HelpTip label="">שעות הפעילות למעלה נמדדות לפי אזור הזמן הזה, לא לפי שעון השרת.</HelpTip>
        </label>
        <select
          id="timezone"
          name="timezone"
          value={values.timezone}
          onChange={(e) => setValues((v) => ({ ...v, timezone: e.target.value }))}
          dir="ltr"
          className={fieldClass("md")}
        >
          {SUPPORTED_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="reminderIntervalHours" className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary">
          מרווח תזכורות (שעות)
          <HelpTip label="">אם הלקוח לא הגיב, Centro ישלח תזכורת נוספת אוטומטית כל X שעות (1-24).</HelpTip>
        </label>
        <input
          id="reminderIntervalHours"
          name="reminderIntervalHours"
          type="number"
          min={1}
          max={24}
          value={values.reminderIntervalHours}
          onChange={(e) => setValues((v) => ({ ...v, reminderIntervalHours: Number(e.target.value) }))}
          className={fieldClass("md")}
        />
        {clientErrors.reminder && <p className="mt-1.5 text-xs font-medium text-danger">{clientErrors.reminder}</p>}
      </div>

      {state.error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      {showSuccess && (
        <p className="flex items-center gap-1.5 rounded-xl border border-brand-emerald/30 bg-brand-emerald/5 px-4 py-3 text-sm font-medium text-brand-emerald">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          ההגדרות נשמרו
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" loading={isPending} disabled={!isDirty || hasClientErrors}>
        {isPending ? "שומר…" : "שמירת הגדרות"}
      </Button>
    </form>
  );
}
