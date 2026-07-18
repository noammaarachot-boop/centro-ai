"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

// BR-18.4: configuration changes are recorded in the audit log.
export async function updateBusinessHours(formData: FormData) {
  const session = await requireSession();

  const businessHoursStart = String(formData.get("businessHoursStart") ?? "09:00");
  const businessHoursEnd = String(formData.get("businessHoursEnd") ?? "18:00");
  const businessDays = WEEKDAYS.filter((day) => formData.get(`day-${day}`) === "on").join(",");
  const reminderIntervalDays = Number(formData.get("reminderIntervalDays") ?? 2);
  const inactivityTimeoutMinutes = Number(formData.get("inactivityTimeoutMinutes") ?? 15);

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      businessHoursStart,
      businessHoursEnd,
      businessDays: businessDays || "0,1,2,3,4",
      reminderIntervalDays,
      inactivityTimeoutMinutes,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "configuration.updated",
    description: "הגדרות שעות הפעילות והתזכורות עודכנו",
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect("/settings");
}
