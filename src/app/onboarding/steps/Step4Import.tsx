"use client";

import { useActionState, useState } from "react";
import { FileSpreadsheet, Sparkles, Upload, Wand2 } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import {
  advanceOnboardingStep,
  confirmImportMapping,
  importAndClassifyClients,
  type ImportClientsState,
} from "../actions";

const initialState: ImportClientsState = {};

const ROLE_LABELS: Record<"name" | "phone" | "email" | "businessType", string> = {
  name: "שם הלקוח",
  phone: "טלפון",
  email: "אימייל",
  businessType: "סוג עסק",
};

export function Step4Import() {
  const [importState, importFormAction, importPending] = useActionState(
    importAndClassifyClients,
    initialState
  );
  const [confirmState, confirmFormAction, confirmPending] = useActionState(
    confirmImportMapping,
    initialState
  );
  const skipStep = advanceOnboardingStep.bind(null, 5);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dismissedMapping, setDismissedMapping] = useState(false);

  const isPending = importPending || confirmPending;
  const mapping = dismissedMapping ? undefined : importState.needsMapping;
  const error = confirmState.error ?? importState.error;

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="relative grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-l from-brand-purple to-brand-blue shadow-glow-purple">
          <Sparkles className="h-7 w-7 animate-pulse text-white" />
        </span>
        <div>
          <p className="text-base font-semibold text-text-primary">
            Centro מנתח את הקובץ שלכם...
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            מייבא לקוחות ומסווג אותם אוטומטית לפי סוג העסק.
          </p>
        </div>
        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-gradient-to-l from-brand-purple to-brand-blue" />
        </div>
      </div>
    );
  }

  if (mapping) {
    return (
      <div className="space-y-5">
        <div className="animate-fade-in-up rounded-2xl border border-brand-purple/25 bg-brand-purple/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <Wand2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-purple" />
            <div>
              <p className="text-sm font-bold text-text-primary">
                לא הצלחנו לזהות את מבנה הקובץ באופן חד־משמעי
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                מצאנו ניחוש סביר לכל עמודה — בדקו ותקנו במידת הצורך לפני שממשיכים בייבוא.
              </p>
            </div>
          </div>
        </div>

        <form action={confirmFormAction} className="space-y-4">
          <input type="hidden" name="rows" value={JSON.stringify(mapping.rows)} />
          <input type="hidden" name="hasHeaderRow" value={mapping.hasHeaderRow ? "1" : "0"} />

          <div className="space-y-3">
            {(["name", "phone", "email", "businessType"] as const).map((role) => {
              const isRequired = role === "name" || role === "phone";
              const suggested = mapping.suggestion[role];
              return (
                <div key={role}>
                  <label
                    htmlFor={`map-${role}`}
                    className="mb-1.5 block text-sm font-medium text-text-secondary"
                  >
                    לדעתנו זו עמודת {ROLE_LABELS[role]}
                    {!isRequired && <span className="text-text-muted"> (לא חובה)</span>}
                  </label>
                  <select
                    id={`map-${role}`}
                    name={`map-${role}`}
                    required={isRequired}
                    defaultValue={suggested !== undefined ? String(suggested) : ""}
                    className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
                  >
                    {!isRequired && <option value="">— ללא —</option>}
                    {isRequired && suggested === undefined && (
                      <option value="" disabled>
                        — בחרו עמודה —
                      </option>
                    )}
                    {mapping.headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header}
                        {mapping.sampleRows[0]?.[index] ? ` (לדוגמה: ${mapping.sampleRows[0][index]})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {mapping.sampleRows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-muted/60">
                    {mapping.headers.map((header, index) => (
                      <th key={index} className="whitespace-nowrap px-3 py-2 text-start font-semibold text-text-secondary">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mapping.sampleRows.slice(0, 3).map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-border">
                      {mapping.headers.map((_, colIndex) => (
                        <td key={colIndex} className="whitespace-nowrap px-3 py-2 text-text-muted">
                          {row[colIndex] || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <p role="alert" className="animate-fade-in-up text-sm font-medium text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
          >
            אישור השיוך והמשך ייבוא
          </button>
        </form>

        <button
          type="button"
          onClick={() => setDismissedMapping(true)}
          className="w-full text-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ביטול — בחירת קובץ אחר
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <form action={importFormAction} className="space-y-4">
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
            כל מבנה עמודות מתקבל — Centro מזהה שם, טלפון, אימייל וסוג עסק אוטומטית לפי התוכן
          </span>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,.xlsx,.xls"
            required
            className="hidden"
            onChange={(e) => {
              setFileName(e.currentTarget.files?.[0]?.name ?? null);
              setDismissedMapping(false);
            }}
          />
        </label>

        {error && (
          <p role="alert" className="animate-fade-in-up text-sm font-medium text-danger">
            {error}
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
