"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";

// A layout only protects the pages it wraps, not the Server Actions
// those pages invoke — each action here independently calls
// requireOwnerSession(), same convention as every other owner action.
export async function suspendOrganizationAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ suspendedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.organization_suspended",
      description: `הארגון "${org.name}" הושעה על ידי ${session.email}`,
      severity: "warning",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect(`/owner/organizations/${organizationId}`);
}

export async function reactivateOrganizationAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.organization_reactivated",
      description: `הארגון "${org.name}" הופעל מחדש על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect(`/owner/organizations/${organizationId}`);
}

// Internal QA Mode — lets one marked organization finish onboarding
// without a real WhatsApp connection (Google Drive is never bypassed),
// for manual testing while Meta's WhatsApp app-review is pending. Called
// from the organizations list page's own small toggle
// (src/app/owner/(dashboard)/organizations/page.tsx), same
// requireOwnerSession() + recordOwnerAuditEvent() convention as
// suspend/reactivate above. The actual bypass is enforced server-side in
// finishOnboarding (src/app/onboarding/actions.ts), which re-reads this
// flag from the authenticated session/DB itself — this action only ever
// flips the flag, it never grants access on its own.
export async function enableQaModeAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ qaModeEnabledAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.qa_mode_enabled",
      description: `מצב בדיקה הופעל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}

export async function disableQaModeAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const db = await getDb();
  const [org] = await db
    .update(organizations)
    .set({ qaModeEnabledAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id, name: organizations.name });

  if (org) {
    await recordOwnerAuditEvent({
      eventType: "owner.qa_mode_disabled",
      description: `מצב בדיקה בוטל עבור "${org.name}" על ידי ${session.email}`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
      metadata: { organizationId: org.id },
    });
  }

  redirect("/owner/organizations");
}
