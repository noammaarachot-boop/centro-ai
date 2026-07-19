import type { Metadata } from "next";
import { getSession } from "@/lib/auth/session";
import { redirectAfterAuth } from "@/lib/onboarding";
import { AuthTabs } from "./AuthTabs";

export const metadata: Metadata = {
  title: "התחברות — Centro",
};

export default async function LoginPage() {
  const session = await getSession();
  if (session) {
    await redirectAfterAuth(session.organizationId);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
        <AuthTabs />
      </div>
    </main>
  );
}
