"use client";

import { useActionState, useState } from "react";
import { buttonVariants } from "@/components/app/Button";
import { updateBusinessCategory, type BusinessCategoryState } from "../actions";
import type { BusinessCategory } from "@/lib/businessCategories";

const initialState: BusinessCategoryState = {};

const PRESETS: Array<{ value: Exclude<BusinessCategory, "other">; label: string }> = [
  { value: "accountant", label: "רואה חשבון" },
  { value: "tax_advisor", label: "יועץ מס" },
  { value: "lawyer", label: "עורך דין" },
  { value: "real_estate", label: "נדל״ן" },
  { value: "mortgage_advisor", label: "יועץ משכנתאות" },
  { value: "insurance", label: "ביטוח" },
  { value: "hr", label: "משאבי אנוש" },
  { value: "finance", label: "ייעוץ פיננסי" },
];

export function Step3BusinessType({
  businessCategory,
  businessCategoryCustomLabel,
}: {
  businessCategory: string;
  businessCategoryCustomLabel: string | null;
}) {
  const [state, formAction, isPending] = useActionState(updateBusinessCategory, initialState);
  const isKnownPreset = PRESETS.some((p) => p.value === businessCategory);
  const [selected, setSelected] = useState<BusinessCategory>(
    isKnownPreset ? (businessCategory as BusinessCategory) : "other"
  );

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => setSelected(preset.value)}
            aria-pressed={selected === preset.value}
            className={`rounded-xl border px-3 py-3 text-center text-sm font-medium transition-colors ${
              selected === preset.value
                ? "border-brand-purple bg-brand-purple/10 text-brand-purple"
                : "border-border bg-surface-muted/40 text-text-secondary hover:border-brand-purple/40"
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSelected("other")}
          aria-pressed={selected === "other"}
          className={`rounded-xl border px-3 py-3 text-center text-sm font-medium transition-colors ${
            selected === "other"
              ? "border-brand-purple bg-brand-purple/10 text-brand-purple"
              : "border-border bg-surface-muted/40 text-text-secondary hover:border-brand-purple/40"
          }`}
        >
          אחר
        </button>
      </div>

      <input type="hidden" name="businessCategory" value={selected} />

      {state.fieldErrors?.businessCategory && (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.fieldErrors.businessCategory}
        </p>
      )}

      {selected === "other" && (
        <div className="animate-fade-in-up">
          <label
            htmlFor="businessCategoryCustomLabel"
            className="mb-1.5 block text-sm font-medium text-text-secondary"
          >
            פרטו את סוג העסק שלכם
          </label>
          <input
            id="businessCategoryCustomLabel"
            name="businessCategoryCustomLabel"
            type="text"
            required
            defaultValue={businessCategoryCustomLabel ?? ""}
            className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
            placeholder="לדוגמה: אדריכלות, וטרינריה, ייעוץ עסקי..."
          />
          {state.fieldErrors?.customLabel && (
            <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
              {state.fieldErrors.customLabel}
            </p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
      >
        המשך
      </button>
    </form>
  );
}
