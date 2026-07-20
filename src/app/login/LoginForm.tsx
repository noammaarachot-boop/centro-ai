"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
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

      <div>
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          סיסמה
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            dir="ltr"
            required
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

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <input
            type="checkbox"
            name="rememberMe"
            className="h-4 w-4 rounded border-border accent-brand-purple"
          />
          זכרו אותי
        </label>
        <Link
          href="/forgot-password"
          className="text-xs font-medium text-brand-purple hover:underline"
        >
          שכחת סיסמה?
        </Link>
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
            מתחבר/ת...
          </>
        ) : (
          <>
            התחברות
            <LogIn className="h-4 w-4" />
          </>
        )}
      </button>

      <p className="text-center text-xs text-text-muted">
        אין לך חשבון?{" "}
        <Link href="/register" className="font-medium text-brand-purple hover:underline">
          יצירת חשבון
        </Link>
      </p>
    </form>
  );
}
