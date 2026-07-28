"use client";

import { advanceOnboardingStep } from "../actions";
import { ImportUploader } from "./ImportUploader";
import { ManualTemplateCreator } from "./ManualTemplateCreator";

export function Step4Import({
  existingTypes,
}: {
  existingTypes: Array<{ id: string; name: string }>;
}) {
  const skipStep = advanceOnboardingStep.bind(null, 7);

  return (
    <div className="space-y-5">
      <ImportUploader mode="add" submitLabel="ייבוא Excel / CSV" />

      <div className="rounded-xl border border-dashed border-border px-3 py-3">
        <p className="mb-2 text-xs text-text-secondary">
          מעדיפים לא להסתמך על סיווג אוטומטי? אפשר גם להגדיר סוגי עסק בעצמכם, בלי לייבא קובץ בכלל.
        </p>
        <ManualTemplateCreator existingTypes={existingTypes} />
      </div>

      <form action={skipStep}>
        <button
          type="submit"
          className="w-full text-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          דלגו בינתיים — אוסיף לקוחות מאוחר יותר
        </button>
      </form>
    </div>
  );
}
