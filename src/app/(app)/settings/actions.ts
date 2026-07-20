"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { runScheduledTasks } from "@/lib/scheduler";
import { clampCollectionDay } from "@/lib/businessHours";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

// BR-18.4: configuration changes are recorded in the audit log.
export async function updateBusinessHours(formData: FormData) {
  const session = await requireSession();

  const businessHoursStart = String(formData.get("businessHoursStart") ?? "09:00");
  const businessHoursEnd = String(formData.get("businessHoursEnd") ?? "18:00");
  const businessDays = WEEKDAYS.filter((day) => formData.get(`day-${day}`) === "on").join(",");
  const reminderIntervalDays = Number(formData.get("reminderIntervalDays") ?? 2);
  const inactivityTimeoutMinutes = Number(formData.get("inactivityTimeoutMinutes") ?? 15);
  const collectionDayOfMonth = clampCollectionDay(formData.get("collectionDayOfMonth"));

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      businessHoursStart,
      businessHoursEnd,
      businessDays: businessDays || "0,1,2,3,4",
      reminderIntervalDays,
      inactivityTimeoutMinutes,
      collectionDayOfMonth,
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

  // This form is always submitted from /settings itself. redirect() to
  // that identical URL doesn't reliably force the client router to drop
  // its cached RSC payload (Next.js 16) — refresh() does, and since we're
  // not navigating anywhere, no redirect() is needed at all.
  refresh();
}

export interface RunSchedulerState {
  result?: { evaluated: number; reminded: number };
}

// Manual stand-in for an external cron hitting POST /api/cron/tick, for
// the pilot until one is actually configured — runs the exact same
// runScheduledTasks() the real endpoint calls. useActionState always
// calls actions as (state, formData); this one just doesn't need either.
export async function runSchedulerNow(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prevState: RunSchedulerState
): Promise<RunSchedulerState> {
  const session = await requireSession();
  const result = await runScheduledTasks(session.organizationId);
  return { result };
}
