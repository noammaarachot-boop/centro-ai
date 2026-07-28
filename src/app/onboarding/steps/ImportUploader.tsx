"use client";

import { useActionState, useState } from "react";
import { FileSpreadsheet, Sparkles, Upload, Wand2 } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { fieldClass } from "@/components/app/FormField";
import {
  confirmImportMapping,
  confirmRowImport,
  importAndClassifyClients,
  type ImportClientsState,
  type ImportMode,
} from "../actions";

const initialState: ImportClientsState = {};

const ROLE_LABELS: Record<"name" | "phone" | "email" | "businessType", string> = {
  name: "שם הלקוח",
  phone: "טלפון",
  email: "אימייל",
  businessType: "סוג עסק",
};

// Shared by Step 4 (the wizard's first, normal import — mode="add") and
// Step 5's "Replace Excel file" / "Add another Excel file" affordances
// (mode="replace" | "add"). All three entry points run the exact same
// two-phase server logic (importAndClassifyClients, then
// confirmImportMapping if the file's structure was ambiguous) — this
// component is just the one place that logic has a UI, so Step 5's
// buttons don't have to re-implement the mapping-confirmation screen.
export function ImportUploader({
  mode,
  submitLabel,
  onCancel,
}: {
  mode: ImportMode;
  submitLabel: string;
  onCancel?: () => void;
}) {
  const [importState, importFormAction, importPending] = useActionState(
    importAndClassifyClients,
    initialState
  );
  const [confirmState, confirmFormAction, confirmPending] = useActionState(
    confirmImportMapping,
    initialState
  );
  const [rowReviewState, rowReviewFormAction, rowReviewPending] = useActionState(
    confirmRowImport,
    initialState
  );
  const [fileName, setFileName] = useState<string | null>(null);
  const [dismissedMapping, setDismissedMapping] = useState(false);
  const [dismissedRowReview, setDismissedRowReview] = useState(false);

  const isPending = importPending || confirmPending || rowReviewPending;
  const mapping = dismissedMapping ? undefined : importState.needsMapping;
  // Smart Profession-Aware Onboarding (item 5) — set by either
  // importAndClassifyClients (confident auto-detection) or
  // confirmImportMapping (after a manual mapping fix); either way, nothing
  // has been written to `clients` yet at this point.
  const rowReview = dismissedRowReview
    ? undefined
    : (importState.needsRowReview ?? confirmState.needsRowReview);
  const error = confirmState.error ?? importState.error;

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="centro-ai-gradient relative grid h-16 w-16 place-items-center rounded-2xl shadow-glow-purple">
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
          <div className="centro-ai-gradient h-full w-1/2 animate-pulse rounded-full" />
        </div>
      </div>
    );
  }

  if (rowReview) {
    return (
      <div className="space-y-5">
        <div className="animate-fade-in-up rounded-2xl border border-brand-purple/25 bg-brand-purple/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-brand-purple" />
            <div>
              <p className="text-sm font-bold text-text-primary">
                {rowReview.rows.length} לקוחות זוהו בקובץ — בדקו לפני שמייבאים
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                שום דבר עדיין לא נשמר. בטלו את הסימון עבור כל שורה שלא רוצים לייבא.
              </p>
            </div>
          </div>
        </div>

        <form action={rowReviewFormAction} className="space-y-4">
          <input type="hidden" name="mode" value={rowReview.mode} />
          <input type="hidden" name="rows" value={JSON.stringify(rowReview.rows)} />
          <input type="hidden" name="analysis" value={JSON.stringify(rowReview.analysis)} />
          <input type="hidden" name="tableBounds" value={JSON.stringify(rowReview.tableBounds)} />
          <input
            type="hidden"
            name="xlsxMeta"
            value={rowReview.xlsxMeta ? JSON.stringify(rowReview.xlsxMeta) : ""}
          />

          <div className="max-h-80 overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-muted/90">
                <tr>
                  <th className="px-2 py-2" />
                  <th className="whitespace-nowrap px-3 py-2 text-start font-semibold text-text-secondary">
                    שם
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-start font-semibold text-text-secondary">
                    טלפון
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-start font-semibold text-text-secondary">
                    אימייל
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-start font-semibold text-text-secondary">
                    סוג עסק
                  </th>
                </tr>
              </thead>
              <tbody>
                {rowReview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        name="include"
                        value={i}
                        defaultChecked
                        aria-label={`ייבוא ${row.name || "שורה " + (i + 1)}`}
                        className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-text-primary">
                      {row.name || "—"}
                    </td>
                    <td dir="ltr" className="whitespace-nowrap px-3 py-1.5 text-text-muted">
                      {row.phone || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-text-muted">
                      {row.email || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-text-muted">
                      {row.businessType || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rowReviewState.error && (
            <p role="alert" className="animate-fade-in-up text-sm font-medium text-danger">
              {rowReviewState.error}
            </p>
          )}

          <button
            type="submit"
            className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
          >
            ייבוא {rowReview.rows.length} לקוחות
          </button>
        </form>

        <button
          type="button"
          onClick={() => (onCancel ? onCancel() : setDismissedRowReview(true))}
          className="w-full text-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ביטול — בחירת קובץ אחר
        </button>
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

        {(mapping.tableBounds.skippedLeadingRows > 0 || mapping.tableBounds.skippedTrailingRows > 0) && (
          <p className="text-xs text-text-muted">
            {mapping.tableBounds.skippedLeadingRows > 0 &&
              `דילגנו על ${mapping.tableBounds.skippedLeadingRows} שורות בתחילת הקובץ שלא נראו כחלק מהטבלה. `}
            {mapping.tableBounds.skippedTrailingRows > 0 &&
              `דילגנו על ${mapping.tableBounds.skippedTrailingRows} שורות בסוף הקובץ (כנראה סיכום).`}
          </p>
        )}

        <form action={confirmFormAction} className="space-y-4">
          <input type="hidden" name="mode" value={mapping.mode} />
          <input type="hidden" name="rows" value={JSON.stringify(mapping.rows)} />
          <input type="hidden" name="hasHeaderRow" value={mapping.hasHeaderRow ? "1" : "0"} />
          <input
            type="hidden"
            name="xlsxMeta"
            value={mapping.xlsxMeta ? JSON.stringify(mapping.xlsxMeta) : ""}
          />
          <input
            type="hidden"
            name="skippedLeadingRows"
            value={mapping.tableBounds.skippedLeadingRows}
          />
          <input
            type="hidden"
            name="skippedTrailingRows"
            value={mapping.tableBounds.skippedTrailingRows}
          />

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
                    className={fieldClass("md")}
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
          onClick={() => (onCancel ? onCancel() : setDismissedMapping(true))}
          className="w-full text-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ביטול — בחירת קובץ אחר
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form action={importFormAction} className="space-y-4">
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
          <span className="text-xs text-text-muted">
            כל מבנה קובץ מתקבל — עמודות בכל סדר, כותרות בעברית או באנגלית, גיליונות מרובים.
            Centro מבין את הקובץ מהתוכן שלו, לא מהכותרות.
          </span>
          <input
            id={`file-${mode}`}
            name="file"
            type="file"
            accept=".csv,.xlsx,.xls"
            required
            className="hidden"
            onChange={(e) => {
              setFileName(e.currentTarget.files?.[0]?.name ?? null);
              setDismissedMapping(false);
              setDismissedRowReview(false);
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
