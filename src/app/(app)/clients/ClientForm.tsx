"use client";

import { useActionState } from "react";
import { Loader2, Save } from "lucide-react";
import type { ClientFormState } from "./actions";

const initialState: ClientFormState = {};

export function ClientForm({
  action,
  submitLabel,
  defaultValues,
}: {
  action: (
    prevState: ClientFormState,
    formData: FormData
  ) => Promise<ClientFormState>;
  submitLabel: string;
  defaultValues?: {
    name: string;
    phone: string;
    email: string | null;
    notes: string | null;
  };
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="name"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          שם הלקוח
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues?.name}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="לדוגמה: ABC בע״מ"
        />
        {state.fieldErrors?.name && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="phone"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          טלפון (וואטסאפ)
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          required
          defaultValue={defaultValues?.phone}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="050-1234567"
        />
        {state.fieldErrors?.phone && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.phone}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          אימייל <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          dir="ltr"
          defaultValue={defaultValues?.email ?? ""}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="name@example.com"
        />
      </div>

      <div>
        <label
          htmlFor="notes"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          הערות <span className="font-normal text-text-muted">(לא חובה)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={defaultValues?.notes ?? ""}
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
