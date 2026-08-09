"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { resolveEmployeeReviewItem } from "@/lib/employeeReview";

export async function resolveReviewItem(formData: FormData) {
  const session = await requireSession();
  const reviewItemId = String(formData.get("reviewItemId") ?? "");
  const resolutionText = String(formData.get("resolutionText") ?? "");
  const promoteToPolicy = formData.get("promoteToPolicy") === "on";
  const policyQuestionSummary = formData.get("policyQuestionSummary")?.toString();
  const policyDecisionText = formData.get("policyDecisionText")?.toString();

  const result = await resolveEmployeeReviewItem({
    organizationId: session.organizationId,
    actorUserId: session.userId,
    reviewItemId,
    resolutionText,
    promoteToPolicy,
    policyQuestionSummary,
    policyDecisionText,
  });

  if (!result.ok) {
    redirect(`/dashboard/review?error=${encodeURIComponent(result.error ?? "שגיאה")}`);
  }

  redirect("/dashboard/review");
}
