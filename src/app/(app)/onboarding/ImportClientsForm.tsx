"use client";

import { useActionState } from "react";
import { Loader2, Upload } from "lucide-react";
import { importClients, type ImportClientsState } from "./actions";

const initialState: ImportClientsState = {};

export function ImportClientsForm() {
  const [state, formAction, isPending] = useActionState(
    importClients,
    initialState
  );

  return (
    <div>
      <form action={formAction} className="flex items-center gap-2">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="flex-1 rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none file:me-3 file:rounded-full file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-text-secondary"
        />
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-4 py-2.5 text-sm font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:opacity-70"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          ייבוא
        </button>
      </form>

      {state.error && (
        <p role="alert" className="mt-3 text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      {state.result && (
        <div className="mt-4 rounded-xl border border-border bg-surface-muted p-4 text-sm">
          <p className="font-medium text-text-primary">
            יובאו {state.result.imported} לקוחות בהצלחה.
          </p>
          {state.result.skipped.length > 0 && (
            <>
              <p className="mt-2 text-text-secondary">
                {state.result.skipped.length} שורות דולגו:
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
                {state.result.skipped.map((row) => (
                  <li key={row.row}>
                    שורה {row.row} ({row.name}): {row.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
