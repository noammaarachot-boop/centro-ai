"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, Save } from "lucide-react";
import { resetPassword, type ResetPasswordState } from "./actions";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";

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

      <TextField
        id="password"
        name="password"
        label="סיסמה חדשה"
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        minLength={8}
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

      <TextField
        id="confirmPassword"
        name="confirmPassword"
        label="אימות סיסמה"
        type={showPassword ? "text" : "password"}
        autoComplete="new-password"
        dir="ltr"
        required
        minLength={8}
        placeholder="••••••••"
      />

      {state.error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        {isPending ? (
          "מעדכן..."
        ) : (
          <>
            <Save className="h-4 w-4" />
            עדכון הסיסמה
          </>
        )}
      </Button>
    </form>
  );
}
