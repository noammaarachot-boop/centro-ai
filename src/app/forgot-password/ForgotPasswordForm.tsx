"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = {};

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestPasswordReset, initialState);

  if (state.submitted) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-brand-emerald/10 text-brand-emerald">
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

      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-text-secondary">
          אימייל
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          dir="ltr"
          required
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="name@example.com"
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
        className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-3.5 text-base font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:opacity-70"
      >
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            שולח...
          </>
        ) : (
          "שליחת קישור לאיפוס"
        )}
      </button>

      <p className="text-center text-xs text-text-muted">
        <Link href="/login" className="font-medium text-brand-purple hover:underline">
          חזרה להתחברות
        </Link>
      </p>
    </form>
  );
}
