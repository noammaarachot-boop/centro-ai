"use server";

import { redirect } from "next/navigation";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";
import { destroyOwnerSession, getOwnerSession } from "@/lib/auth/ownerSession";

export async function ownerLogout() {
  const session = await getOwnerSession();
  if (session) {
    await recordOwnerAuditEvent({
      eventType: "owner.logout",
      description: `${session.email} התנתק/ה ממסוף הבעלים`,
      severity: "info",
      platformOwnerId: session.platformOwnerId,
    });
  }
  await destroyOwnerSession();
  redirect("/owner/login");
}
