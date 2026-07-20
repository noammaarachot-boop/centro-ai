"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { HelpTip } from "@/components/app/HelpTip";

const COLLECTION_DAY_PRESETS = [1, 5, 10, 15, 20, 25];

const DEFAULT_HELP_TEXT =
  "היום בחודש שבו Centro מתחיל לבקש מסמכים. זו מדיניות משרד שנקבעת ידנית — Centro לעולם לא ילמד או ישנה אותה אוטומטית.";

// Shared "collection day of month" field — a <select> of common presets
// (1/5/10/15/20/25) plus a "custom" option revealing a free 1-31 input.
// Always submits a single `collectionDayOfMonth` form field regardless of
// which mode is active (server-side clamped again in
// src/app/onboarding/actions.ts's clampCollectionDay — never trust the
// client alone). Used by both the org-wide default (Settings) and the
// per-Business-Type override (ServiceScheduleOverrideCard) forms.
export function CollectionDayField({
  defaultValue,
  disabled,
  size = "md",
  helpText = DEFAULT_HELP_TEXT,
}: {
  defaultValue: number;
  disabled?: boolean;
  size?: "sm" | "md";
  helpText?: string;
}) {
  const isPreset = COLLECTION_DAY_PRESETS.includes(defaultValue);
  const [dayMode, setDayMode] = useState<"preset" | "custom">(isPreset ? "preset" : "custom");
  const [presetDay, setPresetDay] = useState(isPreset ? defaultValue : COLLECTION_DAY_PRESETS[0]);
  const [customDay, setCustomDay] = useState(defaultValue);

  const labelClass =
    size === "sm"
      ? "mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary"
      : "mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary";
  const controlClass = clsx(
    "rounded-lg border border-border bg-white text-text-primary outline-none focus:border-brand-purple",
    size === "sm" ? "px-2.5 py-2 text-xs" : "px-3 py-2.5 text-sm"
  );

  return (
    <div>
      <label className={labelClass}>
        יום גבייה בחודש
        <span className="pointer-events-auto">
          <HelpTip label="">{helpText}</HelpTip>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <select
          value={dayMode === "custom" ? "custom" : String(presetDay)}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setDayMode("custom");
            } else {
              setDayMode("preset");
              setPresetDay(Number(e.target.value));
            }
          }}
          disabled={disabled}
          className={controlClass}
        >
          {COLLECTION_DAY_PRESETS.map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
          <option value="custom">מותאם אישית (1–31)</option>
        </select>
        {dayMode === "custom" && (
          <input
            type="number"
            min={1}
            max={31}
            value={customDay}
            onChange={(e) => setCustomDay(Number(e.target.value))}
            disabled={disabled}
            className={clsx(controlClass, "w-16")}
          />
        )}
      </div>
      <input
        type="hidden"
        name="collectionDayOfMonth"
        value={dayMode === "custom" ? customDay : presetDay}
      />
    </div>
  );
}
