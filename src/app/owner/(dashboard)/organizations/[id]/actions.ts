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
