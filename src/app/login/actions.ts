"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isRateLimited, clearAttempts, recordFailedAttempt, AUTH_POLICY } from "@/lib/auth/rateLimiter";
import { createSession } from "@/lib/auth/session";
import { redirectAfterAuth } from "@/lib/onboarding";
import { validateRegistrationFields } from "./registrationValidation";

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
  const rememberMe = formData.get("rememberMe") === "on";

  if (!email || !password) {
    return { error: "נא להזין אימייל וסיסמה." };
  }

  // Keyed by the submitted email, not IP: this is a single shared account
  // per organization (BR-13.1), so a brute-force attempt is inherently
  // targeted at one specific email regardless of source IP.
  if (await isRateLimited(`login:${email}`, AUTH_POLICY)) {
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
    await recordFailedAttempt(`login:${email}`, AUTH_POLICY);
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  const passwordIsValid = await verifyPassword(password, user.passwordHash);
  if (!passwordIsValid) {
    await recordFailedAttempt(`login:${email}`, AUTH_POLICY);
    await recordAuditEvent({
      organizationId: user.organizationId,
      eventType: "employee.login_failed",
      description: `ניסיון התחברות כושל עבור ${user.email}`,
      actorType: "employee",
      actorUserId: user.id,
    });
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  await clearAttempts(`login:${email}`);

  await createSession(user.id, user.organizationId, rememberMe);
  await recordAuditEvent({
    organizationId: user.organizationId,
    eventType: "employee.login",
    description: `${user.email} התחבר/ה למערכת`,
    actorType: "employee",
    actorUserId: user.id,
  });

  return redirectAfterAuth(user.organizationId);
}

export interface RegisterState {
  error?: string;
  fieldErrors?: {
    fullName?: string;
    phone?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
    terms?: string;
  };
}

const EMAIL_TAKEN_MESSAGE = "כתובת אימייל זו כבר רשומה במערכת.";

export async function register(
  _prevState: RegisterState,
  formData: FormData
): Promise<RegisterState> {
  const fullName = String(formData.get("fullName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const termsAccepted = formData.get("termsAccepted") === "on";

  const fieldErrors = validateRegistrationFields({
    fullName,
    phone,
    email,
    password,
    confirmPassword,
    termsAccepted,
  });
  if (fieldErrors) return { fieldErrors };

  const db = await getDb();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { fieldErrors: { email: EMAIL_TAKEN_MESSAGE } };
  }

  // `name` here is a temporary placeholder, not a real product decision —
  // self-service registration deliberately doesn't ask for an office/company
  // name (see src/lib/onboarding.ts). Collecting the real name is planned as
  // onboarding wizard step 1 in the next epic; nothing downstream treats
  // this value as final.
  //
  // First-Send Journey — every new self-service signup starts on-demand.
  // The onboarding wizard is now a single, unbranched flow with no
  // "Collection Style" choice screen (see onboarding/page.tsx's own
  // comment), so this is the one place that decision gets made — the
  // schema's own default is "recurring" (Ch.9's original, still-accurate
  // default for any other path that creates an organization), which would
  // be wrong here if left unset.
  const [organization] = await db
    .insert(organizations)
    .values({ name: fullName, workflowType: "on_demand" })
    .returning({ id: organizations.id });

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const [user] = await db
    .insert(users)
    .values({
      organizationId: organization.id,
      email,
      passwordHash,
      fullName,
      phone,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
    })
    .returning({ id: users.id, email: users.email });

  await recordAuditEvent({
    organizationId: organization.id,
    eventType: "organization.created",
    description: `הארגון נוצר באמצעות הרשמה עצמאית (${user.email})`,
    actorType: "system",
  });
  await recordAuditEvent({
    organizationId: organization.id,
    eventType: "employee.registered",
    description: `${user.email} נרשם/ה למערכת`,
    actorType: "employee",
    actorUserId: user.id,
  });

  await createSession(user.id, organization.id);

  return redirectAfterAuth(organization.id);
}
