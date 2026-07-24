"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { ownerLogin, type OwnerLoginState } from "./actions";
import { TextField } from "@/components/app/FormField";
import { Button } from "@/components/app/Button";
import { t } from "@/lib/owner/i18n/t";

const initialState: OwnerLoginState = {};

export function OwnerLoginForm() {
  const [state, formAction, isPending] = useActionState(ownerLogin, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <TextField
        id="email"
        name="email"
        label={t("owner.login.emailLabel")}
        type="email"
        inputMode="email"
        autoComplete="username"
        dir="ltr"
        required
        placeholder="owner@example.com"
      />

      <TextField
        id="password"
        name="password"
        label={t("owner.login.passwordLabel")}
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

      {state.error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" loading={isPending} className="w-full">
        {isPending ? (
          t("owner.login.submitPending")
        ) : (
          <>
            {t("owner.login.submit")}
            <LogIn className="h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}
