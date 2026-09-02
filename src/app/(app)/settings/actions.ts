"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { assertDevToolsEnabled } from "@/lib/devTools";
import { runScheduledTasks } from "@/lib/scheduler";
import { isSupportedTimezone } from "@/lib/businessHours";
import {
  MAX_HUMAN_REVIEW_AFTER_DAYS,
  MIN_HUMAN_REVIEW_AFTER_DAYS,
  isValidHumanReviewAfterDays,
} from "@/lib/attention/policy";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export interface SettingsFormState {
  error?: string;
}

// BR-18.4: configuration changes are recorded in the audit log.
//
// Validate-then-reject, never clamp-then-save: an out-of-range/malformed
// value returns an error and writes nothing at all (no partial
// persistence) — the office re-submits with a corrected value, rather
// than silently having Centro "fix" what they typed. inactivityTimeoutMinutes/
// collectionDayOfMonth are deliberately absent from both the validated
// fields and the .set() below — this form no longer edits them (Settings
// UI polish), but they're real fields the scheduler/recurringScheduler
// still read; omitting them from .set() (rather than re-writing whatever
// this form doesn't submit) leaves their current stored value untouched.
export async function updateBusinessHours(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await requireSession();

  const businessHoursStart = String(formData.get("businessHoursStart") ?? "09:00");
  const businessHoursEnd = String(formData.get("businessHoursEnd") ?? "18:00");
  const businessDays = WEEKDAYS.filter((day) => formData.get(`day-${day}`) === "on").join(",");
  const timezone = String(formData.get("timezone") ?? "Asia/Jerusalem");
  const reminderIntervalHoursRaw = Number(formData.get("reminderIntervalHours"));
  const humanReviewAfterDaysRaw = Number(formData.get("humanReviewAfterDays"));

  if (!businessDays) {
    return { error: "יש לבחור לפחות יום עבודה אחד." };
  }
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(businessHoursStart) || !timePattern.test(businessHoursEnd)) {
    return { error: "יש להזין שעת התחלה ושעת סיום תקינות." };
  }
  if (businessHoursStart >= businessHoursEnd) {
    return { error: "שעת הסיום חייבת להיות מאוחרת משעת ההתחלה." };
  }
  if (!Number.isInteger(reminderIntervalHoursRaw) || reminderIntervalHoursRaw < 1 || reminderIntervalHoursRaw > 24) {
    return { error: "מרווח התזכורות חייב להיות מספר שלם בין 1 ל-24 שעות." };
  }
  // Validate-then-reject, like every other field here: clamping 45 into 30
  // would save a policy the office never chose and never tell them. There is
  // deliberately no "unlimited" — a request nobody is ever told about is not
  // a feature.
  if (!isValidHumanReviewAfterDays(humanReviewAfterDaysRaw)) {
    return {
      error: `מספר ימי הפעילות להעברה לטיפול אנושי חייב להיות מספר שלם בין ${MIN_HUMAN_REVIEW_AFTER_DAYS} ל-${MAX_HUMAN_REVIEW_AFTER_DAYS}.`,
    };
  }
  if (!isSupportedTimezone(timezone)) {
    return { error: "אזור הזמן שנבחר אינו נתמך." };
  }

  const db = await getDb();
  await db
    .update(organizations)
    .set({
      businessHoursStart,
      businessHoursEnd,
      businessDays,
      timezone,
      reminderIntervalHours: reminderIntervalHoursRaw,
      humanReviewAfterDays: humanReviewAfterDaysRaw,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, session.organizationId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "configuration.updated",
    // Names what actually changed, including the human-review window — an
    // office reading its own audit trail should be able to see that the
    // threshold governing "דורש טיפול" was moved, and to what.
    description: `הגדרות שעות הפעילות והתזכורות עודכנו (העברה לטיפול אנושי אחרי ${humanReviewAfterDaysRaw} ימי פעילות)`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  // This form is always submitted from /settings itself. redirect() to
  // that identical URL doesn't reliably force the client router to drop
  // its cached RSC payload (Next.js 16) — refresh() does, and since we're
  // not navigating anywhere, no redirect() is needed at all.
  refresh();
  return {};
}

export interface RunSchedulerState {
  result?: { evaluated: number; reminded: number; delivered: number };
}

// Manual stand-in for an external cron hitting POST /api/cron/tick, for
// the pilot until one is actually configured — runs the exact same
// runScheduledTasks() the real endpoint calls. useActionState always
// calls actions as (state, formData); this one just doesn't need either.
export async function runSchedulerNow(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prevState: RunSchedulerState
): Promise<RunSchedulerState> {
  // Development-only. This runs the real scheduler for the caller's
  // organization, which really does send WhatsApp messages to real
  // clients — it must never be reachable from a production tenant, and a
  // Server Action stays callable even when its UI is not rendered.
  assertDevToolsEnabled();
  const session = await requireSession();
  const result = await runScheduledTasks(session.organizationId);
  return { result };
}
