"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { platformOwners } from "@/db/schema";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";
import { verifyPassword } from "@/lib/auth/password";
import { isRateLimited, clearAttempts, recordFailedAttempt } from "@/lib/auth/rateLimiter";
import { createOwnerSession } from "@/lib/auth/ownerSession";
import { redirect } from "next/navigation";
import { t } from "@/lib/owner/i18n/t";

export interface OwnerLoginState {
  error?: string;
}

// Mirrors src/app/login/actions.ts's login() closely — same rate-limiting,
// same scrypt password verification, same "unknown email still counts
// against the rate limit but isn't itself logged" behavior (there's no
// platform-owner row to attribute an audit event to for an unrecognized
// email). A Server Action, not a Route Handler, so it keeps Next.js's
// automatic same-origin Origin-header protection.
export async function ownerLogin(
  _prevState: OwnerLoginState,
  formData: FormData
): Promise<OwnerLoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: t("owner.login.missingFields") };
  }

  const rateLimitKey = `owner:${email}`;
  if (isRateLimited(rateLimitKey)) {
    return { error: t("owner.login.rateLimited") };
  }

  const db = await getDb();
  const [owner] = await db
    .select()
    .from(platformOwners)
    .where(eq(platformOwners.email, email))
    .limit(1);

  if (!owner) {
    recordFailedAttempt(rateLimitKey);
    return { error: t("owner.login.invalidCredentials") };
  }

  const passwordIsValid = await verifyPassword(password, owner.passwordHash);
  if (!passwordIsValid) {
    recordFailedAttempt(rateLimitKey);
    await recordOwnerAuditEvent({
      eventType: "owner.login_failed",
      description: `ניסיון התחברות כושל עבור ${owner.email}`,
      severity: "warning",
      platformOwnerId: owner.id,
    });
    return { error: t("owner.login.invalidCredentials") };
  }

  clearAttempts(rateLimitKey);

  await createOwnerSession(owner.id);
  await recordOwnerAuditEvent({
    eventType: "owner.login",
    description: `${owner.email} התחבר/ה למסוף הבעלים`,
    severity: "info",
    platformOwnerId: owner.id,
  });

  redirect("/owner");
}
