"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { isRateLimited, clearAttempts, recordFailedAttempt } from "@/lib/auth/rateLimiter";
import { createSession } from "@/lib/auth/session";

export interface LoginState {
  error?: string;
}

const INVALID_CREDENTIALS_MESSAGE = "פרטי ההתחברות שגויים.";
const RATE_LIMITED_MESSAGE = "יותר מדי ניסיונות התחברות כושלים. נא לנסות שוב בעוד כמה דקות.";

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "נא להזין אימייל וסיסמה." };
  }

  // Keyed by the submitted email, not IP: this is a single shared account
  // per organization (BR-13.1), so a brute-force attempt is inherently
  // targeted at one specific email regardless of source IP.
  if (isRateLimited(email)) {
    return { error: RATE_LIMITED_MESSAGE };
  }

  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // No organization to attribute an audit event to when the email doesn't
  // match any account, so an unknown email is intentionally not logged —
  // still counts against the rate limit, though, so enumerating emails
  // can't be used to dodge it.
  if (!user) {
    recordFailedAttempt(email);
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  const passwordIsValid = await verifyPassword(password, user.passwordHash);
  if (!passwordIsValid) {
    recordFailedAttempt(email);
    await recordAuditEvent({
      organizationId: user.organizationId,
      eventType: "employee.login_failed",
      description: `ניסיון התחברות כושל עבור ${user.email}`,
      actorType: "employee",
      actorUserId: user.id,
    });
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  clearAttempts(email);

  await createSession(user.id, user.organizationId);
  await recordAuditEvent({
    organizationId: user.organizationId,
    eventType: "employee.login",
    description: `${user.email} התחבר/ה למערכת`,
    actorType: "employee",
    actorUserId: user.id,
  });

  redirect("/dashboard");
}
