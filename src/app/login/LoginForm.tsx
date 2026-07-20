"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { login, type LoginState } from "./actions";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
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

      <TextField
        id="password"
        name="password"
        label="סיסמה"
        type={showPassword ? "text" : "password"}
        autoComplete="current-password"
        dir="ltr"
        required
        placeholder="••••••••"
        endAdornment={
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="text-text-muted transition-colors hover:text-brand-purple"
            aria-label={showPassword ? "הסתרת הסיסמה" : "הצגת הסיסמה"}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        }
      />

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

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        {isPending ? (
          "מתחבר/ת..."
        ) : (
          <>
            התחברות
            <LogIn className="h-4 w-4" />
          </>
        )}
      </Button>

      <p className="text-center text-xs text-text-muted">
        אין לך חשבון?{" "}
        <Link href="/register" className="font-medium text-brand-purple hover:underline">
          יצירת חשבון
        </Link>
      </p>
    </form>
  );
}
