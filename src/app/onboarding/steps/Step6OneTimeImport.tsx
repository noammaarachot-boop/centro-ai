"use client";

import { useActionState, useState } from "react";
import { FileSpreadsheet, FileUp, RefreshCcw, Sparkles, Upload } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { advanceOnboardingStep, importClientsSimple, type OneTimeImportState } from "../actions";

const initialState: OneTimeImportState = {};

// Product fix — the same upload/replace/add-another interaction pattern
// as the recurring workflow's Step5Analysis (RefreshCcw "replace" /
// FileUp "add another" buttons revealing an inline upload form), wired to
// this workflow's own importClientsSimple (name+phone only, no
// classification — a deliberate, unchanged divergence).
function OneTimeUploadForm({
  mode,
  submitLabel,
  helperText,
  onCancel,
}: {
  mode: "add" | "replace";
  submitLabel: string;
  helperText: string;
  onCancel?: () => void;
}) {
  const [state, formAction, isPending] = useActionState(importClientsSimple, initialState);
  const [fileName, setFileName] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="centro-ai-gradient grid h-16 w-16 place-items-center rounded-2xl shadow-glow-purple">
          <Sparkles className="h-7 w-7 animate-pulse text-white" />
        </span>
        <p className="text-base font-semibold text-text-primary">מייבא לקוחות...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="mode" value={mode} />
        <label
          htmlFor={`file-${mode}`}
          className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border bg-surface-muted/40 px-6 py-10 text-center transition-colors hover:border-brand-purple/40 hover:bg-brand-purple/5"
        >
          <span className="centro-icon-purple grid h-12 w-12 place-items-center rounded-2xl">
            <FileSpreadsheet className="h-6 w-6" />
          </span>
          <span className="text-sm font-medium text-text-primary">
            {fileName ?? "לחצו כדי לבחור קובץ Excel / CSV"}
          </span>
          <span className="text-xs text-text-muted">{helperText}</span>
          <input
            id={`file-${mode}`}
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
          {submitLabel}
        </button>
      </form>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="w-full text-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ביטול
        </button>
      )}
    </div>
  );
}

export function Step6OneTimeImport({ totalClients }: { totalClients: number }) {
  const [activeUploader, setActiveUploader] = useState<"replace" | "add" | null>(null);
  const goToStep7 = advanceOnboardingStep.bind(null, 7);
  const skipStep = advanceOnboardingStep.bind(null, 7);

  // Nothing imported yet — the original single upload-or-skip screen,
  // unchanged.
  if (totalClients === 0 && activeUploader === null) {
    return (
      <div className="space-y-5">
        <OneTimeUploadForm
          mode="add"
          submitLabel="ייבוא Excel / CSV"
          helperText="רק שם וטלפון יישמרו — ללא סיווג או ניתוח נוסף."
        />
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

  return (
    <div className="space-y-5">
      {totalClients > 0 && !activeUploader && (
        <div className="animate-fade-in-up flex items-center gap-3 rounded-2xl border border-brand-emerald/25 bg-brand-emerald/5 px-5 py-4">
          <AnimatedCheckBadge size={28} />
          <div>
            <p className="text-sm font-bold text-text-primary">{totalClients} לקוחות יובאו</p>
            <p className="text-xs text-text-secondary">
              אפשר להחליף את הקובץ, להוסיף עוד לקוחות, או להמשיך הלאה.
            </p>
          </div>
        </div>
      )}

      {activeUploader ? (
        <OneTimeUploadForm
          mode={activeUploader}
          submitLabel={activeUploader === "replace" ? "החלפת הקובץ" : "הוספת הקובץ"}
          helperText={
            activeUploader === "replace"
              ? "העלו קובץ Excel / CSV חדש. הלקוחות שיובאו מהקובץ הקודם יוסרו — לקוחות קיימים או שנוספו ידנית לא ייפגעו."
              : "העלו קובץ Excel / CSV נוסף. הלקוחות בו יתווספו לרשימה הקיימת."
          }
          onCancel={() => setActiveUploader(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveUploader("replace")}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            החלפת קובץ Excel
          </button>
          <button
            type="button"
            onClick={() => setActiveUploader("add")}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <FileUp className="h-3.5 w-3.5" />
            הוספת קובץ Excel נוסף
          </button>
        </div>
      )}

      {!activeUploader && (
        <form action={goToStep7}>
          <button
            type="submit"
            className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
          >
            המשך
          </button>
        </form>
      )}
    </div>
  );
}
