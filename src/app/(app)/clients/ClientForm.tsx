"use client";

import { useActionState } from "react";
import { Save } from "lucide-react";
import type { ClientFormState } from "./actions";
import { TextField, TextAreaField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

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
    <form action={formAction} className="space-y-5">
      <TextField
        id="name"
        name="name"
        label="שם הלקוח"
        type="text"
        required
        defaultValue={defaultValues?.name}
        placeholder="לדוגמה: ABC בע״מ"
        error={state.fieldErrors?.name}
      />

      <TextField
        id="phone"
        name="phone"
        label="טלפון (וואטסאפ)"
        type="tel"
        inputMode="tel"
        dir="ltr"
        required
        defaultValue={defaultValues?.phone}
        placeholder="050-1234567"
        className="text-end"
        error={state.fieldErrors?.phone}
      />

      <TextField
        id="email"
        name="email"
        label="אימייל"
        optional
        type="email"
        dir="ltr"
        defaultValue={defaultValues?.email ?? ""}
        placeholder="name@example.com"
        className="text-end"
      />

      <TextAreaField
        id="notes"
        name="notes"
        label="הערות"
        optional
        rows={3}
        defaultValue={defaultValues?.notes ?? ""}
      />

      {state.error && (
        <p role="alert" className="animate-fade-in-up text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" loading={isPending}>
        <Save className="h-4 w-4" />
        {submitLabel}
      </Button>
    </form>
  );
}
