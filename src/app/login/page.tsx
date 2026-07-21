import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { redirectAfterAuth } from "@/lib/onboarding";
import { AuthTabs } from "./AuthTabs";
import { AuthCard } from "@/components/app/AuthCard";

export const metadata: Metadata = {
  title: "התחברות — Centro",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; reset?: string }>;
}) {
  const session = await getSession();
  if (session) {
    await redirectAfterAuth(session.organizationId);
  }
  const { mode, reset } = await searchParams;

  return (
    <AuthCard
      showMark
      above={
        reset === "success" && (
          <p className="flex items-center gap-2 rounded-xl border border-brand-emerald/25 bg-brand-emerald/5 px-4 py-3 text-sm font-medium text-text-primary">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-emerald" />
            הסיסמה עודכנה בהצלחה. אפשר להתחבר עם הסיסמה החדשה.
          </p>
        )
      }
    >
      <AuthTabs initialMode={mode === "register" ? "register" : "login"} />
    </AuthCard>
  );
}
