"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import { resetPassword, type ResetPasswordState } from "./actions";

const initialState: ResetPasswordState = {};

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(resetPassword, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-text-primary">קביעת סיסמה חדשה</h1>
        <p className="mb-6 text-sm text-text-secondary">בחרו סיסמה חדשה לחשבון.</p>
      </div>

      <input type="hidden" name="token" value={token} />

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-text-secondary">
          סיסמה חדשה
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            dir="ltr"
            required
            minLength={8}
            className="w-full rounded-xl border border-border bg-white px-4 py-3 ps-11 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
            placeholder="••••••••"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 start-0 flex items-center px-3 text-text-muted transition-colors hover:text-brand-purple"
            aria-label={showPassword ? "הסתרת הסיסמה" : "הצגת הסיסמה"}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          אימות סיסמה
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          dir="ltr"
          required
          minLength={8}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="••••••••"
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
            מעדכן...
          </>
        ) : (
          <>
            <Save className="h-4 w-4" />
            עדכון הסיסמה
          </>
        )}
      </button>
    </form>
  );
}
