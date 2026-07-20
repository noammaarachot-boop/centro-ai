"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { isRateLimited, recordFailedAttempt } from "@/lib/auth/rateLimiter";
import { sendPasswordResetEmail } from "@/lib/email/passwordReset";

export interface ForgotPasswordState {
  submitted?: boolean;
  error?: string;
}

const GENERIC_MESSAGE_STATE: ForgotPasswordState = { submitted: true };
const RATE_LIMITED_MESSAGE = "יותר מדי בקשות איפוס סיסמה. נא לנסות שוב בעוד כמה דקות.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_DURATION_MS = 60 * 60 * 1000; // 1 hour

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData
): Promise<ForgotPasswordState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!email || !EMAIL_PATTERN.test(email)) {
    return { error: "נא להזין כתובת אימייל תקינה." };
  }

  // Namespaced separately from login's rate-limit key (different concerns:
  // a user locked out of login should never also be blocked from
  // requesting a reset, and vice versa) but keyed the same way (per
  // email, not IP) — see src/app/login/actions.ts's identical reasoning.
  const rateLimitKey = `reset:${email}`;
  if (isRateLimited(rateLimitKey)) {
    return { error: RATE_LIMITED_MESSAGE };
  }
  recordFailedAttempt(rateLimitKey);

  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // No user enumeration: an unknown email counts against the rate limit
  // (above) and returns the exact same success state as a real one, with
  // no distinguishing timing-relevant work skipped.
  if (!user) {
    return GENERIC_MESSAGE_STATE;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_DURATION_MS);
  await db.insert(passwordResetTokens).values({ userId: user.id, token, expiresAt });

  const headersList = await headers();
  const host = headersList.get("host") ?? "localhost:3000";
  const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
  const resetUrl = `${protocol}://${host}/reset-password?token=${token}`;

  await sendPasswordResetEmail(email, resetUrl);

  // Records only that a reset was requested — never the token or URL.
  // auditLogs rows are permanent/undeletable by design (FR-17.4), so a
  // live, unused credential must never end up in one.
  await recordAuditEvent({
    organizationId: user.organizationId,
    eventType: "employee.password_reset_requested",
    description: `איפוס סיסמה התבקש עבור ${user.email}`,
    actorType: "employee",
    actorUserId: user.id,
  });

  return GENERIC_MESSAGE_STATE;
}
