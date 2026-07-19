import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { getOrganization } from "@/lib/data/organizations";

// Single predicate behind the onboarding gate (Epic 2). Both the post-auth
// redirect below and the (app) layout's defensive check call this, rather
// than each re-implementing the condition — see src/app/(app)/layout.tsx
// and the register()/login() actions in src/app/login/actions.ts.
export function needsOnboarding(organization: { onboardingCompletedAt: Date | null }): boolean {
  return !organization.onboardingCompletedAt;
}

// The one place that decides where a freshly authenticated session lands.
// Called as the last step of both login() and register() — never a
// hardcoded redirect("/dashboard") in either — so both entry points make
// the exact same decision.
export async function redirectAfterAuth(organizationId: string): Promise<never> {
  const organization = await getOrganization(organizationId);
  if (organization && needsOnboarding(organization)) {
    redirect("/onboarding");
  }
  redirect("/dashboard");
}

// Called once Office Setup (today) / the onboarding wizard (next epic) is
// done. Kept separate from the org row's other columns so either flow can
// call it without knowing about the other's internals.
export async function markOnboardingComplete(organizationId: string) {
  const db = await getDb();
  await db
    .update(organizations)
    .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}
