import type { Metadata } from "next";
import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { AuthCard } from "@/components/app/AuthCard";

export const metadata: Metadata = {
  title: "שכחתי סיסמה — Centro",
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard>
      <ForgotPasswordForm />
    </AuthCard>
  );
}
