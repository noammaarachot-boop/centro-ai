"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2, UserPlus } from "lucide-react";
import { register, type RegisterState } from "./actions";

const initialState: RegisterState = {};

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(register, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="fullName"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          שם מלא
        </label>
        <input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          required
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="לדוגמה: דנה כהן"
        />
        {state.fieldErrors?.fullName && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.fullName}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="register-email"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          אימייל
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          dir="ltr"
          required
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          placeholder="name@example.com"
        />
        {state.fieldErrors?.email && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.email}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="register-password"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          סיסמה
        </label>
        <div className="relative">
          <input
            id="register-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            dir="ltr"
            required
            className="w-full rounded-xl border border-border bg-white px-4 py-3 pe-11 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
            placeholder="לפחות 8 תווים"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "הסתרת סיסמה" : "הצגת סיסמה"}
            className="absolute inset-y-0 right-3 grid place-items-center text-text-muted transition-colors hover:text-text-primary"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {state.fieldErrors?.password && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.password}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="mb-1.5 block text-sm font-medium text-text-secondary"
        >
          אימות סיסמה
        </label>
        <div className="relative">
          <input
            id="confirmPassword"
            name="confirmPassword"
            type={showConfirmPassword ? "text" : "password"}
            autoComplete="new-password"
            dir="ltr"
            required
            className="w-full rounded-xl border border-border bg-white px-4 py-3 pe-11 text-end text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
            placeholder="הקלידו את הסיסמה שוב"
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword((v) => !v)}
            aria-label={showConfirmPassword ? "הסתרת סיסמה" : "הצגת סיסמה"}
            className="absolute inset-y-0 right-3 grid place-items-center text-text-muted transition-colors hover:text-text-primary"
          >
            {showConfirmPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        {state.fieldErrors?.confirmPassword && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.confirmPassword}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            name="termsAccepted"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-brand-purple"
          />
          <span>
            קראתי ואני מסכים/ה ל
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-purple hover:underline"
            >
              תנאי השימוש
            </Link>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            name="privacyAccepted"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-brand-purple"
          />
          <span>
            קראתי ואני מסכים/ה ל
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-purple hover:underline"
            >
              מדיניות הפרטיות
            </Link>
          </span>
        </label>
        {state.fieldErrors?.terms && (
          <p role="alert" className="text-xs font-medium text-danger">
            {state.fieldErrors.terms}
          </p>
        )}
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
            יוצר/ת חשבון...
          </>
        ) : (
          <>
            יצירת חשבון
            <UserPlus className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}
