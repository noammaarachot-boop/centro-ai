"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

export interface LoginState {
  error?: string;
}

const INVALID_CREDENTIALS_MESSAGE = "פרטי ההתחברות שגויים.";

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

  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // No organization to attribute an audit event to when the email doesn't
  // match any account, so an unknown email is intentionally not logged.
  if (!user) {
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  const passwordIsValid = await verifyPassword(password, user.passwordHash);
  if (!passwordIsValid) {
    await recordAuditEvent({
      organizationId: user.organizationId,
      eventType: "employee.login_failed",
      description: `ניסיון התחברות כושל עבור ${user.email}`,
      actorType: "employee",
      actorUserId: user.id,
    });
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

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
