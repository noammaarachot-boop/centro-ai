"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { LoginForm } from "./LoginForm";
import { RegisterForm } from "./RegisterForm";

type Mode = "login" | "register";

const COPY: Record<Mode, { title: string; description: string }> = {
  login: {
    title: "התחברות ל-Centro",
    description: "התחברו עם חשבון העסק המשותף שהוגדר עבורכם.",
  },
  register: {
    title: "יצירת חשבון ב-Centro",
    description: "פתחו חשבון חדש והתחילו לעבוד עם Centro תוך דקות.",
  },
};

export function AuthTabs() {
  const [mode, setMode] = useState<Mode>("login");

  return (
    <div>
      <div
        role="tablist"
        aria-label="התחברות או הרשמה"
        className="mb-6 flex gap-1 rounded-full border border-border bg-surface-muted p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          onClick={() => setMode("login")}
          className={clsx(
            "flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
            mode === "login"
              ? "bg-white text-text-primary shadow-card"
              : "text-text-muted hover:text-text-primary"
          )}
        >
          התחברות
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "register"}
          onClick={() => setMode("register")}
          className={clsx(
            "flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
            mode === "register"
              ? "bg-white text-text-primary shadow-card"
              : "text-text-muted hover:text-text-primary"
          )}
        >
          יצירת חשבון
        </button>
      </div>

      <h1 className="mb-1 text-xl font-semibold text-text-primary">
        {COPY[mode].title}
      </h1>
      <p className="mb-6 text-sm text-text-secondary">{COPY[mode].description}</p>

      {mode === "login" ? <LoginForm /> : <RegisterForm />}
    </div>
  );
}
