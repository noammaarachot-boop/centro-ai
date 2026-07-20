import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { findValidResetToken } from "./actions";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { AuthCard } from "@/components/app/AuthCard";

export const metadata: Metadata = {
  title: "איפוס סיסמה — Centro",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  // A page-load check purely for UX (don't show a form for an obviously
  // dead link) - the action re-validates independently at submit time,
  // since a link can expire or get used in another tab in between.
  const tokenRow = token ? await findValidResetToken(token) : null;

  return (
    <AuthCard>
      {tokenRow ? (
        <ResetPasswordForm token={token!} />
      ) : (
        <div className="text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-danger/10 text-danger">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <h1 className="mb-1 text-xl font-semibold text-text-primary">
            קישור האיפוס אינו תקין
          </h1>
          <p className="mb-6 text-sm text-text-secondary">
            הקישור אינו תקין, כבר נעשה בו שימוש, או שפג תוקפו. אפשר לבקש קישור חדש.
          </p>
          <Link
            href="/forgot-password"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-purple hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            בקשת קישור חדש
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
