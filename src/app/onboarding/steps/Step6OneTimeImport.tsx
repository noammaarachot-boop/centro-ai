"use client";

import { useActionState, useState } from "react";
import { FileSpreadsheet, Sparkles, Upload } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { advanceOnboardingStep, importClientsSimple, type OneTimeImportState } from "../actions";

const initialState: OneTimeImportState = {};

// Workflow B's own, deliberately simpler Import step — stores only name
// and phone, no classification/analysis (see importClientsSimple's own
// comment). Distinct component from the recurring path's Step4Import
// rather than a shared one with a mode flag, since the two experiences
// genuinely diverge (no mapping-confirmation screen, no "here's what
// Centro understood" summary, different copy) — forcing them through one
// component would need more branching than just having two.
export function Step6OneTimeImport() {
  const [state, formAction, isPending] = useActionState(importClientsSimple, initialState);
  const [fileName, setFileName] = useState<string | null>(null);
  const skipStep = advanceOnboardingStep.bind(null, 7);

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-l from-brand-purple to-brand-blue shadow-glow-purple">
          <Sparkles className="h-7 w-7 animate-pulse text-white" />
        </span>
        <p className="text-base font-semibold text-text-primary">מייבא לקוחות...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <form action={formAction} className="space-y-4">
        <label
          htmlFor="file"
          className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border bg-surface-muted/40 px-6 py-10 text-center transition-colors hover:border-brand-purple/40 hover:bg-brand-purple/5"
        >
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-purple/10 text-brand-purple">
            <FileSpreadsheet className="h-6 w-6" />
          </span>
          <span className="text-sm font-medium text-text-primary">
            {fileName ?? "לחצו כדי לבחור קובץ Excel / CSV"}
          </span>
          <span className="text-xs text-text-muted">
            רק שם וטלפון יישמרו — ללא סיווג או ניתוח נוסף.
          </span>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,.xlsx,.xls"
            required
            className="hidden"
            onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? null)}
          />
        </label>

        {state.error && (
          <p role="alert" className="animate-fade-in-up text-sm font-medium text-danger">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          <Upload className="h-4 w-4" />
          ייבוא Excel / CSV
        </button>
      </form>

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
