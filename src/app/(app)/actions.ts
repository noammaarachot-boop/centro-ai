"use server";

import { redirect } from "next/navigation";
import { recordAuditEvent } from "@/lib/audit";
import { destroySession, getSession } from "@/lib/auth/session";

export async function logout() {
  const session = await getSession();
  if (session) {
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "employee.logout",
      description: `${session.email} התנתק/ה מהמערכת`,
      actorType: "employee",
      actorUserId: session.userId,
    });
  }
  await destroySession();
  redirect("/login");
}
