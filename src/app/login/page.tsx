import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "התחברות — Centro",
};

export default async function LoginPage() {
  const session = await getSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
        <h1 className="mb-1 text-xl font-semibold text-text-primary">
          התחברות ל-Centro
        </h1>
        <p className="mb-6 text-sm text-text-secondary">
          התחברו עם חשבון המשרד המשותף שהוגדר עבורכם.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
