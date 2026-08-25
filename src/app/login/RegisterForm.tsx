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
      // See LoginForm: padding grows the 16px icon's tap area to 32px, the
      // equal negative margin keeps the icon exactly where it was.
      className="-m-2 p-2 text-text-muted transition-colors hover:text-brand-purple"
    >
      {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(register, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  // React 19 runs a native form.reset() after every Server Action call,
  // success or failure alike, which wipes these fields' real DOM values
  // (including forcing the checkbox's `checked` back to false) without
  // touching this component's own state. Bumping `resetGeneration` on
  // each new action response forces a fresh remount of the fields below
  // via `key`, so they always re-initialize from the state that's
  // actually still accurate instead of the DOM's clobbered one.
  const [resetGeneration, setResetGeneration] = useState(0);
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    setResetGeneration((g) => g + 1);
    if (state.fieldErrors?.password || state.fieldErrors?.confirmPassword) {
      setPassword("");
      setConfirmPassword("");
    }
  }

  return (
    <form action={formAction} className="space-y-4">
      <TextField
        key={`fullName-${resetGeneration}`}
        id="fullName"
        name="fullName"
        label="שם מלא"
        type="text"
        autoComplete="name"
        required
        placeholder="לדוגמה: דנה כהן"
        error={state.fieldErrors?.fullName}
        defaultValue={fullName}
        onChange={(e) => setFullName(e.target.value)}
      />

      <TextField
        key={`phone-${resetGeneration}`}
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
        defaultValue={phone}
        onChange={(e) => setPhone(e.target.value)}
      />

      <TextField
        key={`email-${resetGeneration}`}
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
        defaultValue={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <TextField
        key={`password-${resetGeneration}`}
        id="register-password"
        name="password"
        label="סיסמה"
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        placeholder="לפחות 8 תווים"
        error={state.fieldErrors?.password}
        defaultValue={password}
        onChange={(e) => setPassword(e.target.value)}
        endAdornment={
          <PasswordToggle visible={showPassword} onToggle={() => setShowPassword((v) => !v)} />
        }
      />

      <TextField
        key={`confirmPassword-${resetGeneration}`}
        id="confirmPassword"
        name="confirmPassword"
        label="אימות סיסמה"
        type={showConfirmPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        placeholder="הקלידו את הסיסמה שוב"
        error={state.fieldErrors?.confirmPassword}
        defaultValue={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
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
            key={`terms-${resetGeneration}`}
            type="checkbox"
            name="termsAccepted"
            defaultChecked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
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
