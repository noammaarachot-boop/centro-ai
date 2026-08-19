import nodemailer from "nodemailer";
import { withRetry } from "@/lib/resilience";

const CATEGORY_LABELS: Record<string, string> = {
  not_working: "משהו לא עובד",
  google_drive: "בעיה בחיבור Google Drive",
  whatsapp: "בעיה ב-WhatsApp",
  question: "שאלה על המערכת",
  feature_request: "בקשה / הצעה",
  other: "אחר",
};

export interface SupportRequestEmailInput {
  ticketNumber: number;
  organizationId: string;
  organizationName: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  category: string;
  subject: string;
  message: string;
  currentPage: string | null;
  timezone: string | null;
  createdAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Support screen email delivery — reuses the exact same Gmail SMTP
 * mechanism already configured in production for the marketing contact
 * form and password reset (GMAIL_USER/GMAIL_APP_PASSWORD), rather than
 * introducing a second provider/credential for the same job. Sent to
 * CONTACT_EMAIL_TO — there is no separate "support@" address anywhere in
 * this codebase's config today, so this reuses Centro's one existing
 * inbound inbox rather than inventing a new address.
 *
 * Unlike sendPasswordResetEmail (which deliberately swallows failures to
 * avoid leaking account existence), this THROWS on failure/misconfiguration
 * — the caller (submitSupportRequest) must know delivery actually
 * succeeded before it's allowed to show the user a success confirmation.
 * The request itself is already durably persisted in support_requests
 * before this is ever called, so a thrown error here never loses data —
 * it only withholds a premature "success".
 */
export async function sendSupportRequestEmail(input: SupportRequestEmailInput): Promise<void> {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD is not configured");
  }
  const to = process.env.CONTACT_EMAIL_TO || "Centro.ai.team@gmail.com";

  const categoryLabel = CATEGORY_LABELS[input.category] ?? input.category;
  const createdAtDisplay = input.createdAt.toLocaleString("he-IL", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Jerusalem",
  });

  const rows: Array<[string, string]> = [
    ["מספר פנייה", `#${input.ticketNumber}`],
    ["סוג פנייה", categoryLabel],
    ["נושא", input.subject],
    ["שם", input.userName || "לא סופק"],
    ["אימייל", input.userEmail],
    ["עסק", input.organizationName],
    ["עמוד נוכחי", input.currentPage || "לא סופק"],
    ["אזור זמן", input.timezone || "לא סופק"],
    ["תאריך ושעה", createdAtDisplay],
    ["User ID", input.userId],
    ["Organization ID", input.organizationId],
  ];

  const html = `
    <div dir="rtl" style="font-family: Arial, Helvetica, sans-serif; background: #f5f4fb; padding: 32px 16px;">
      <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e6e4f2;">
        <div style="background: linear-gradient(135deg, #7c3aed, #3b6dff); padding: 24px 28px;">
          <h1 style="margin: 0; color: #ffffff; font-size: 18px; font-weight: 700;">פנייה חדשה לתמיכה — Centro</h1>
        </div>
        <div style="padding: 24px 28px;">
          <table style="width: 100%; border-collapse: collapse;">
            ${rows
              .map(
                ([label, value]) => `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #efeefa; color: #6b6880; font-size: 13px; font-weight: 600; white-space: nowrap; vertical-align: top;">${escapeHtml(label)}</td>
                <td style="padding: 10px 0 10px 16px; border-bottom: 1px solid #efeefa; color: #1c1a2b; font-size: 14px; white-space: pre-wrap;">${escapeHtml(value)}</td>
              </tr>`
              )
              .join("")}
          </table>
          <p style="margin: 20px 0 0; color: #6b6880; font-size: 13px; font-weight: 600;">תיאור</p>
          <p style="margin: 6px 0 0; color: #1c1a2b; font-size: 14px; white-space: pre-wrap;">${escapeHtml(input.message)}</p>
        </div>
      </div>
    </div>
  `.trim();

  const text = [...rows.map(([label, value]) => `${label}: ${value}`), "", "תיאור:", input.message].join("\n");

  await withRetry(() => {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailAppPassword },
    });
    return transporter.sendMail({
      from: `"Centro Support" <${gmailUser}>`,
      to,
      replyTo: input.userEmail,
      subject: `[Support #${input.ticketNumber}] ${categoryLabel} — ${input.subject}`,
      html,
      text,
    });
  });
}
