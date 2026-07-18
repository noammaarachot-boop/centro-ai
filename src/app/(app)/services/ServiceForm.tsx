"use client";

import { useActionState } from "react";
import { Loader2, Save } from "lucide-react";
import type { ServiceFormState } from "./actions";

const initialState: ServiceFormState = {};

export function ServiceForm({
  action,
  submitLabel,
  defaultValues,
}: {
  action: (
    prevState: ServiceFormState,
    formData: FormData
  ) => Promise<ServiceFormState>;
  submitLabel: string;
  defaultValues?: { name: string; description: string | null };
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="name"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          שם השירות
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues?.name}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="לדוגמה: דוח מע״מ חודשי"
        />
        {state.fieldErrors?.name && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="description"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          תיאור <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={defaultValues?.description ?? ""}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
        />
      </div>

      {state.error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="flex items-center justify-center gap-2 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-3 text-sm font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:opacity-70"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Save className="h-4 w-4" />
        )}
        {submitLabel}
      </button>
    </form>
  );
}
