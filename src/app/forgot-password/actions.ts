"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { isRateLimited, recordFailedAttempt, AUTH_POLICY } from "@/lib/auth/rateLimiter";
import { sendPasswordResetEmail } from "@/lib/email/passwordReset";
import { isEmailConfigured } from "@/lib/email/mailer";

export interface ForgotPasswordState {
  submitted?: boolean;
  error?: string;
}

const GENERIC_MESSAGE_STATE: ForgotPasswordState = { submitted: true };
const RATE_LIMITED_MESSAGE = "יותר מדי בקשות איפוס סיסמה. נא לנסות שוב בעוד כמה דקות.";
// Shown when the email could not actually be delivered. Telling someone to
// check an inbox that will never receive anything leaves them locked out
// with no idea why, and no other way back into the account.
const DELIVERY_FAILED_MESSAGE =
  "שליחת מייל האיפוס נכשלה כרגע. נא לנסות שוב בעוד כמה דקות, ואם הבעיה נמשכת פנו לתמיכה.";
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
  if (await isRateLimited(rateLimitKey, AUTH_POLICY)) {
    return { error: RATE_LIMITED_MESSAGE };
  }
  await recordFailedAttempt(rateLimitKey, AUTH_POLICY);

  // Checked BEFORE the account lookup, deliberately. If email is not
  // configured at all, every address must fail identically — answering
  // "check your inbox" for unknown addresses but an error for real ones
  // would turn a misconfiguration into a user-enumeration oracle.
  if (!isEmailConfigured()) {
    console.error(
      "[forgot-password] GMAIL_USER / GMAIL_APP_PASSWORD is not configured — no reset email can be sent"
    );
    return { error: DELIVERY_FAILED_MESSAGE };
  }

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

  try {
    await sendPasswordResetEmail(email, resetUrl);
  } catch (error) {
    // A transient send failure. Not an enumeration risk in the way the
    // configuration case is: it is not attacker-controllable, so it cannot
    // be used to probe one address against another. Reported honestly
    // rather than hidden behind a success message.
    console.error("[forgot-password] reset email failed to send", error);
    await recordAuditEvent({
      organizationId: user.organizationId,
      eventType: "employee.password_reset_email_failed",
      description: `שליחת מייל איפוס סיסמה נכשלה עבור ${user.email}`,
      actorType: "employee",
      actorUserId: user.id,
      metadata: { severity: "critical" },
    });
    return { error: DELIVERY_FAILED_MESSAGE };
  }

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
