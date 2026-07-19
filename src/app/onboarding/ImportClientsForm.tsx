"use client";

import { useActionState } from "react";
import { Upload } from "lucide-react";
import { importClients, type ImportClientsState } from "./actions";
import { Button } from "@/components/app/Button";

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
          className="flex-1 rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 file:me-3 file:rounded-full file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-text-secondary focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
        />
        <Button type="submit" variant="primary" loading={isPending}>
          <Upload className="h-4 w-4" />
          ייבוא
        </Button>
      </form>

      {state.error && (
        <p role="alert" className="mt-3 animate-fade-in-up text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      {state.result && (
        <div className="mt-4 animate-fade-in-up rounded-xl border border-border bg-surface-muted p-4 text-sm">
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
