"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

const initialState: ForgotPasswordState = {};

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestPasswordReset, initialState);

  if (state.submitted) {
    return (
      <div className="text-center">
        <div className="centro-icon-emerald mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full">
          <Mail className="h-6 w-6" />
        </div>
        <h1 className="mb-1 text-xl font-semibold text-text-primary">בדקו את תיבת הדואר</h1>
        <p className="mb-6 text-sm text-text-secondary">
          אם קיים חשבון המשויך לכתובת האימייל שהזנתם, נשלח אליה קישור לאיפוס הסיסמה.
        </p>
        <Link
          href="/login"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-purple hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה להתחברות
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-text-primary">שכחתם סיסמה?</h1>
        <p className="mb-6 text-sm text-text-secondary">
          הזינו את כתובת האימייל של החשבון, ונשלח אליכם קישור לאיפוס הסיסמה.
        </p>
      </div>

      <TextField
        id="email"
        name="email"
        label="אימייל"
        type="email"
        inputMode="email"
        autoComplete="username"
        dir="ltr"
        required
        placeholder="name@example.com"
      />

      {state.error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        {isPending ? "שולח..." : "שליחת קישור לאיפוס"}
      </Button>

      <p className="text-center text-xs text-text-muted">
        <Link href="/login" className="font-medium text-brand-purple hover:underline">
          חזרה להתחברות
        </Link>
      </p>
    </form>
  );
}
