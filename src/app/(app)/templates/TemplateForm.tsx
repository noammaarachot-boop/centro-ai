"use client";

import { useActionState } from "react";
import { Save } from "lucide-react";
import type { TemplateFormState } from "./actions";
import { TextField, TextAreaField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

const initialState: TemplateFormState = {};

export function TemplateForm({
  action,
  submitLabel,
  defaultValues,
}: {
  action: (
    prevState: TemplateFormState,
    formData: FormData
  ) => Promise<TemplateFormState>;
  submitLabel: string;
  defaultValues?: { name: string; description: string | null };
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <TextField
        id="name"
        name="name"
        label="שם התבנית"
        type="text"
        required
        defaultValue={defaultValues?.name}
        placeholder="לדוגמה: חוזה שכירות"
        error={state.fieldErrors?.name}
      />

      <TextAreaField
        id="description"
        name="description"
        label="תיאור"
        optional
        rows={3}
        defaultValue={defaultValues?.description ?? ""}
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
