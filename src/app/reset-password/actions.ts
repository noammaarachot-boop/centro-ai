"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";

export interface ResetPasswordState {
  error?: string;
}

const INVALID_TOKEN_MESSAGE = "קישור האיפוס אינו תקין או שפג תוקפו. נא לבקש קישור חדש.";
const MIN_PASSWORD_LENGTH = 8;

// Shared by the page (to decide whether to render the form at all) and
// the action (the actual authority — a link can expire or get used in
// another tab between page load and submit, so the page-load check alone
// is never sufficient).
export async function findValidResetToken(token: string) {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.token, token),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .limit(1);
  return row ?? null;
}

export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים.` };
  }
  if (password !== confirmPassword) {
    return { error: "הסיסמאות אינן תואמות." };
  }

  const tokenRow = await findValidResetToken(token);
  if (!tokenRow) {
    return { error: INVALID_TOKEN_MESSAGE };
  }

  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1);
  if (!user) {
    return { error: INVALID_TOKEN_MESSAGE };
  }

  const passwordHash = await hashPassword(password);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  // Single-use: mark consumed rather than deleting, matching auditLogs'
  // own insert-only spirit — never the token/URL itself, just that it
  // happened.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, tokenRow.id));

  await recordAuditEvent({
    organizationId: user.organizationId,
    eventType: "employee.password_reset_completed",
    description: `הסיסמה אופסה עבור ${user.email}`,
    actorType: "employee",
    actorUserId: user.id,
  });

  redirect("/login?reset=success");
}
