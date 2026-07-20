"use client";

import { useState } from "react";
import { LoginForm } from "./LoginForm";
import { RegisterForm } from "./RegisterForm";
import { Tabs } from "@/components/app/Tabs";

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

export function AuthTabs({ initialMode = "login" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);

  return (
    <div>
      <Tabs
        label="התחברות או הרשמה"
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        items={[
          { value: "login", label: "התחברות" },
          { value: "register", label: "יצירת חשבון" },
        ]}
      />

      <h1 className="mt-6 mb-1 text-xl font-semibold text-text-primary">
        {COPY[mode].title}
      </h1>
      <p className="mb-6 text-sm text-text-secondary">{COPY[mode].description}</p>

      {mode === "login" ? <LoginForm /> : <RegisterForm />}
    </div>
  );
}
