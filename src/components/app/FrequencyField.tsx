"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { HelpTip } from "@/components/app/HelpTip";
import { fieldClass, type FieldSize } from "@/components/app/FormField";

// Product Evolution M9 — the presets requested up front (monthly / every 2
// months / quarterly / every 6 months / annually), each just a label over
// "every X months." Mirrors CollectionDayField.tsx's own preset+custom
// pattern exactly, for the same reason: a single underlying number
// (collectionFrequencyIntervalMonths) covers every named option and
// "custom" at once — deliberately not a separate unit/enum, to keep this
// as simple as the schema itself.
const FREQUENCY_PRESETS: Array<{ months: number; label: string }> = [
  { months: 1, label: "מדי חודש" },
  { months: 2, label: "כל חודשיים" },
  { months: 3, label: "רבעוני (כל 3 חודשים)" },
  { months: 6, label: "כל 6 חודשים" },
  { months: 12, label: "שנתי" },
];

const PRESET_MONTHS = new Set(FREQUENCY_PRESETS.map((p) => p.months));

export function FrequencyField({
  defaultValue,
  disabled,
  size = "md",
}: {
  defaultValue: number | null;
  disabled?: boolean;
  size?: FieldSize;
}) {
  const initial = defaultValue ?? 1;
  const isPreset = PRESET_MONTHS.has(initial);
  const [mode, setMode] = useState<"preset" | "custom">(isPreset ? "preset" : "custom");
  const [presetMonths, setPresetMonths] = useState(isPreset ? initial : 1);
  const [customMonths, setCustomMonths] = useState(initial);

  const labelClass = clsx(
    "mb-1.5 flex items-center gap-1 font-medium text-text-secondary",
    size === "sm" ? "text-xs" : "text-sm"
  );
  const controlClass = fieldClass(size, "cursor-pointer");

  return (
    <div>
      <label className={labelClass}>
        תדירות
        <span className="pointer-events-auto">
          <HelpTip label="">
            כל כמה זמן Centro פותח מחזור איסוף חדש עבור כל לקוח המשויך — לדוגמה חודשי או
            רבעוני. זה שונה ממרווח התזכורות, שקובע מה קורה בתוך מחזור פתוח שעדיין ממתין
            למסמכים.
          </HelpTip>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <select
          value={mode === "custom" ? "custom" : String(presetMonths)}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setMode("custom");
            } else {
              setMode("preset");
              setPresetMonths(Number(e.target.value));
            }
          }}
          disabled={disabled}
          className={clsx(controlClass, "w-auto")}
        >
          {FREQUENCY_PRESETS.map((preset) => (
            <option key={preset.months} value={preset.months}>
              {preset.label}
            </option>
          ))}
          <option value="custom">מותאם אישית (כל X חודשים)</option>
        </select>
        {mode === "custom" && (
          <div className="flex items-center gap-1.5">
            <span className={clsx(size === "sm" ? "text-xs" : "text-sm", "text-text-secondary")}>
              כל
            </span>
            <input
              type="number"
              min={1}
              max={36}
              value={customMonths}
              onChange={(e) => setCustomMonths(Number(e.target.value))}
              disabled={disabled}
              className={clsx(fieldClass(size), "w-16")}
            />
            <span className={clsx(size === "sm" ? "text-xs" : "text-sm", "text-text-secondary")}>
              חודשים
            </span>
          </div>
        )}
      </div>
      <input
        type="hidden"
        name="collectionFrequencyIntervalMonths"
        value={mode === "custom" ? customMonths : presetMonths}
      />
    </div>
  );
}
