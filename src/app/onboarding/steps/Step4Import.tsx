"use client";

import { advanceOnboardingStep } from "../actions";
import { ImportUploader } from "./ImportUploader";

export function Step4Import() {
  const skipStep = advanceOnboardingStep.bind(null, 5);

  return (
    <div className="space-y-5">
      <ImportUploader mode="add" submitLabel="ייבוא Excel / CSV" />

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
