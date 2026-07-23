"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, UserPlus } from "lucide-react";
import { register, type RegisterState } from "./actions";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

const initialState: RegisterState = {};

function PasswordToggle({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? "הסתרת סיסמה" : "הצגת סיסמה"}
      className="text-text-muted transition-colors hover:text-brand-purple"
    >
      {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(register, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [termsAndPrivacyAccepted, setTermsAndPrivacyAccepted] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <TextField
        id="fullName"
        name="fullName"
        label="שם מלא"
        type="text"
        autoComplete="name"
        required
        placeholder="לדוגמה: דנה כהן"
        error={state.fieldErrors?.fullName}
      />

      <TextField
        id="register-phone"
        name="phone"
        label="טלפון"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        dir="ltr"
        required
        placeholder="050-1234567"
        error={state.fieldErrors?.phone}
      />

      <TextField
        id="register-email"
        name="email"
        label="אימייל"
        type="email"
        inputMode="email"
        autoComplete="email"
        dir="ltr"
        required
        placeholder="name@example.com"
        error={state.fieldErrors?.email}
      />

      <TextField
        id="register-password"
        name="password"
        label="סיסמה"
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        placeholder="לפחות 8 תווים"
        error={state.fieldErrors?.password}
        endAdornment={
          <PasswordToggle visible={showPassword} onToggle={() => setShowPassword((v) => !v)} />
        }
      />

      <TextField
        id="confirmPassword"
        name="confirmPassword"
        label="אימות סיסמה"
        type={showConfirmPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        placeholder="הקלידו את הסיסמה שוב"
        error={state.fieldErrors?.confirmPassword}
        endAdornment={
          <PasswordToggle
            visible={showConfirmPassword}
            onToggle={() => setShowConfirmPassword((v) => !v)}
          />
        }
      />

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={termsAndPrivacyAccepted}
            onChange={(e) => setTermsAndPrivacyAccepted(e.target.checked)}
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
            </Link>{" "}
            ול
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-purple hover:underline"
            >
              מדיניות הפרטיות
            </Link>
            .
          </span>
        </label>
        {/* actions.ts's register() reads two separate form fields
            (termsAccepted / privacyAccepted) and records two separate
            *_AcceptedAt timestamps — both mirrored from the single
            checkbox above so neither the server action nor the DB schema
            need to change for a single-checkbox UI. */}
        <input type="checkbox" name="termsAccepted" checked={termsAndPrivacyAccepted} readOnly hidden />
        <input type="checkbox" name="privacyAccepted" checked={termsAndPrivacyAccepted} readOnly hidden />
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

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        {isPending ? (
          "יוצר/ת חשבון..."
        ) : (
          <>
            יצירת חשבון
            <UserPlus className="h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}
