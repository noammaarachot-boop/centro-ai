"use server";

import { getDb } from "@/db";
import { supportRequests } from "@/db/schema";
import { eq } from "drizzle-orm";
import { recordAuditEvent } from "@/lib/audit";
import { consumeRateLimit, SUBMISSION_POLICY } from "@/lib/auth/rateLimiter";
import { requireSession } from "@/lib/auth/session";
import { sendSupportRequestEmail } from "@/lib/email/supportRequest";

const VALID_CATEGORIES = new Set([
  "not_working",
  "google_drive",
  "whatsapp",
  "question",
  "feature_request",
  "other",
]);

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 4000;
const CURRENT_PAGE_MAX = 300;
const TIMEZONE_MAX = 100;

export interface SupportRequestState {
  error?: string;
  success?: { ticketNumber: number };
}

// Authenticated employees only, per requireSession() below — a support
// request can never be filed anonymously. Rate-limited per user (not IP,
// unlike the public marketing contact form) since every caller here is
// already a known, logged-in identity.

// BR-18.4-style discipline (same as Settings' updateBusinessHours):
// validate-then-reject, never partial persistence. user id/name/email and
// organization id/name are always read from the server-side session, never
// trusted from formData — a spoofed "organizationId" field in the request
// body is simply never read.
export async function submitSupportRequest(
  _prevState: SupportRequestState,
  formData: FormData
): Promise<SupportRequestState> {
  const session = await requireSession();

  if (await consumeRateLimit(`support:${session.userId}`, SUBMISSION_POLICY)) {
    return { error: "יותר מדי פניות בזמן קצר. נסו שוב בעוד כמה דקות." };
  }

  const category = String(formData.get("category") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  const currentPage = String(formData.get("currentPage") ?? "").trim().slice(0, CURRENT_PAGE_MAX) || null;
  const timezone = String(formData.get("timezone") ?? "").trim().slice(0, TIMEZONE_MAX) || null;

  if (!VALID_CATEGORIES.has(category)) {
    return { error: "נא לבחור סוג פנייה." };
  }
  if (!subject) {
    return { error: "נא להזין נושא." };
  }
  if (subject.length > SUBJECT_MAX) {
    return { error: `הנושא ארוך מדי (מקסימום ${SUBJECT_MAX} תווים).` };
  }
  if (!message) {
    return { error: "נא לתאר מה קרה." };
  }
  if (message.length > MESSAGE_MAX) {
    return { error: `התיאור ארוך מדי (מקסימום ${MESSAGE_MAX} תווים).` };
  }

  const db = await getDb();
  const [row] = await db
    .insert(supportRequests)
    .values({
      organizationId: session.organizationId,
      userId: session.userId,
      userName: session.fullName,
      userEmail: session.email,
      organizationName: session.organizationName,
      category: category as (typeof supportRequests.$inferInsert)["category"],
      subject,
      message,
      currentPage,
      timezone,
      deliveryStatus: "pending",
    })
    .returning({ id: supportRequests.id, ticketNumber: supportRequests.ticketNumber, createdAt: supportRequests.createdAt });

  // BR-17.1-style: the request is durably persisted above BEFORE any email
  // attempt, so a transient Gmail outage never loses it — only withholds
  // the user-facing success confirmation until delivery genuinely happens.
  try {
    await sendSupportRequestEmail({
      ticketNumber: row.ticketNumber,
      organizationId: session.organizationId,
      organizationName: session.organizationName,
      userId: session.userId,
      userName: session.fullName,
      userEmail: session.email,
      category,
      subject,
      message,
      currentPage,
      timezone,
      createdAt: row.createdAt,
    });
  } catch (error) {
    const emailError = error instanceof Error ? error.message : String(error);
    await db
      .update(supportRequests)
      .set({ deliveryStatus: "failed", emailError: emailError.slice(0, 500) })
      .where(eq(supportRequests.id, row.id));
    return { error: "שליחת הפנייה נכשלה. נסו שוב בעוד רגע." };
  }

  await db
    .update(supportRequests)
    .set({ deliveryStatus: "sent", emailSentAt: new Date() })
    .where(eq(supportRequests.id, row.id));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "support.request_created",
    description: `פנייה לתמיכה נשלחה — #${row.ticketNumber}`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { ticketNumber: row.ticketNumber, category, subject },
  });

  return { success: { ticketNumber: row.ticketNumber } };
}
