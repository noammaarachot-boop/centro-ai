import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOwnerSession } from "@/lib/auth/ownerSession";
import { AuthCard } from "@/components/app/AuthCard";
import { OwnerLoginForm } from "./OwnerLoginForm";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = {
  title: t("owner.login.pageTitle"),
};

export default async function OwnerLoginPage() {
  const session = await getOwnerSession();
  if (session) {
    redirect("/owner");
  }

  return (
    <AuthCard>
      <div className="mb-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-purple">
          {t("owner.login.subheading")}
        </p>
        <h1 className="mt-1 text-xl font-bold text-text-primary">
          {t("owner.login.heading")}
        </h1>
      </div>
      <OwnerLoginForm />
    </AuthCard>
  );
}
