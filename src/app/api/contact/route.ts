import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { getDb } from "@/db";
import { leads } from "@/db/schema";
import { withRetry } from "@/lib/resilience";
import { toE164 } from "@/lib/whatsapp/phone";
import { sendTemplateMessage } from "@/lib/whatsapp/send";
import { LEAD_WELCOME_TEMPLATE } from "@/lib/whatsapp/templates";

export const dynamic = "force-dynamic";

const NAME_MAX = 200;
const BUSINESS_NAME_MAX = 200;
const MESSAGE_MAX = 2000;
const PHONE_PATTERN = /^[\d\s\-+()]{7,16}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Anything submitted faster than this after the form rendered is almost
// certainly a bot filling every field programmatically, not a person
// reading and typing.
const MIN_SUBMIT_MS = 1500;

// Process-local, in-memory rate limiting — this route has exactly one
// call site, so a small dedicated Map here (rather than a shared/
// parameterized module) matches this codebase's "no abstraction beyond
// what's needed" convention. Same "single pilot instance" caveat as
// src/lib/auth/rateLimiter.ts.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_SUBMISSIONS = 5;
const submissionsByIp = new Map<string, { count: number; firstAt: number }>();

function isRateLimited(ip: string): boolean {
  const entry = submissionsByIp.get(ip);
  if (!entry || Date.now() - entry.firstAt > RATE_WINDOW_MS) {
    submissionsByIp.set(ip, { count: 1, firstAt: Date.now() });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_SUBMISSIONS;
}

interface ContactPayload {
  name: string;
  phone: string;
  email?: string;
  businessName?: string;
  message?: string;
  source: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mirrors ContactForm's own client-side validation (src/components/
// landing/ContactForm.tsx) — required again here since the client check
// is only a UX convenience, never a security boundary.
function parsePayload(body: unknown): { value: ContactPayload } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "בקשה לא תקינה." };
  }
  const { name, phone, email, businessName, message, source } = body as Record<string, unknown>;

  if (typeof name !== "string" || !name.trim() || name.trim().length > NAME_MAX) {
    return { error: "נא להזין שם מלא." };
  }
  if (typeof phone !== "string" || !PHONE_PATTERN.test(phone.trim())) {
    return { error: "נא להזין מספר טלפון תקין." };
  }
  if (email !== undefined && email !== null && email !== "") {
    if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
      return { error: "נא להזין כתובת אימייל תקינה." };
    }
  }
  if (businessName !== undefined && businessName !== null && businessName !== "") {
    if (typeof businessName !== "string" || businessName.length > BUSINESS_NAME_MAX) {
      return { error: "שם העסק ארוך מדי." };
    }
  }
  if (message !== undefined && message !== null && message !== "") {
    if (typeof message !== "string" || message.length > MESSAGE_MAX) {
      return { error: "ההודעה ארוכה מדי." };
    }
  }

  return {
    value: {
      name: name.trim(),
      phone: phone.trim(),
      email: typeof email === "string" && email.trim() ? email.trim() : undefined,
      businessName: typeof businessName === "string" && businessName.trim() ? businessName.trim() : undefined,
      message: typeof message === "string" && message.trim() ? message.trim() : undefined,
      source: typeof source === "string" && source.trim() ? source.trim() : "לא ידוע",
    },
  };
}

function clientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

// Feature 1 (M-WA-5): persists the lead and best-effort WhatsApps them a
// welcome message from Centro's own sales number — deliberately separate
// from any customer organization's connected number (Features 2/3),
// since these are Centro's own leads, not a customer's client. Never
// throws: a WhatsApp failure (or the org not having configured
// CENTRO_WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_LEAD_WELCOME_TEMPLATE_NAME
// yet) is recorded on the lead row for visibility, never surfaced to the
// visitor — email delivery is the only thing this route's success
// depends on, exactly as before this feature existed.
async function recordLeadAndSendWelcome(input: {
  name: string;
  phone: string;
  email?: string;
  businessName?: string;
  message?: string;
  source: string;
}): Promise<void> {
  const db = await getDb();
  const phoneE164 = toE164(input.phone);

  const [lead] = await db
    .insert(leads)
    .values({
      name: input.name,
      phone: input.phone,
      phoneE164,
      email: input.email,
      businessName: input.businessName,
      message: input.message,
      source: input.source,
      emailSentAt: new Date(),
      whatsappStatus: phoneE164 ? "pending" : "not_applicable",
    })
    .returning();

  const phoneNumberId = process.env.CENTRO_WHATSAPP_PHONE_NUMBER_ID;
  const templateName = process.env.WHATSAPP_LEAD_WELCOME_TEMPLATE_NAME;
  if (!phoneE164 || !phoneNumberId || !templateName) return;

  try {
    const result = await sendTemplateMessage(phoneNumberId, phoneE164, templateName, LEAD_WELCOME_TEMPLATE.language, [
      input.name,
    ]);
    await db
      .update(leads)
      .set({ whatsappStatus: "sent", whatsappMessageId: result.messageId })
      .where(eq(leads.id, lead.id));
  } catch (error) {
    const whatsappError = error instanceof Error ? error.message : String(error);
    await db
      .update(leads)
      .set({ whatsappStatus: "failed", whatsappError: whatsappError.slice(0, 500) })
      .where(eq(leads.id, lead.id));
  }
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
  }

  // Honeypot + minimum-time-to-submit spam checks run before anything
  // else and, deliberately, never surface a different response than a
  // real success — showing a bot a distinct rejection just teaches it to
  // adapt. A genuine visitor can never trigger either: the honeypot field
  // is invisible (sr-only) and no person reads the form and fills it in
  // under 1.5 seconds.
  const { honeypot, renderedAt } = body as { honeypot?: unknown; renderedAt?: unknown };
  const submittedTooFast =
    typeof renderedAt === "number" && Number.isFinite(renderedAt) && Date.now() - renderedAt < MIN_SUBMIT_MS;
  if ((typeof honeypot === "string" && honeypot.trim() !== "") || submittedTooFast) {
    console.log(`[contact] blocked as spam (ip=${ip}, honeypot=${!!honeypot}, tooFast=${submittedTooFast})`);
    return NextResponse.json({ status: "ok" });
  }

  const parsed = parsePayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { name, phone, email, businessName, message, source } = parsed.value;

  if (isRateLimited(ip)) {
    console.log(`[contact] rate-limited (ip=${ip})`);
    return NextResponse.json(
      { error: "יותר מדי פניות בזמן קצר. נסו שוב בעוד כמה דקות." },
      { status: 429 }
    );
  }

  console.log(`[contact] submission received (ip=${ip}, source="${source}", name="${name}")`);

  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    console.error("[contact] GMAIL_USER / GMAIL_APP_PASSWORD is not configured");
    return NextResponse.json(
      { error: "שירות השליחה אינו זמין כרגע. נסו שוב מאוחר יותר." },
      { status: 503 }
    );
  }

  const to = process.env.CONTACT_EMAIL_TO || "Centro.ai.team@gmail.com";

  const submittedAt = new Date().toLocaleString("he-IL", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Jerusalem",
  });

  const rows: Array<[string, string]> = [
    ["שם מלא", name],
    ["טלפון", phone],
    ["אימייל", email || "לא סופק"],
    ["שם העסק", businessName || "לא סופק"],
    ["הודעה", message || "לא סופקה"],
    ["תאריך ושעה", submittedAt],
    ["מקור", source],
  ];

  const html = `
    <div dir="rtl" style="font-family: Arial, Helvetica, sans-serif; background: #f5f4fb; padding: 32px 16px;">
      <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e6e4f2;">
        <div style="background: linear-gradient(135deg, #7c3aed, #3b6dff); padding: 24px 28px;">
          <h1 style="margin: 0; color: #ffffff; font-size: 18px; font-weight: 700;">פנייה חדשה מאתר Centro</h1>
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
          <p style="margin: 20px 0 0; color: #9b98ad; font-size: 12px;">
            הודעה זו נשלחה אוטומטית מטופס יצירת הקשר באתר Centro.
          </p>
        </div>
      </div>
    </div>
  `.trim();

  const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");

  // Gmail SMTP always sends as the authenticated account regardless of what
  // "from" is set to (anti-spoofing) — GMAIL_USER is both the auth identity
  // and the visible sender. No domain verification or DNS records needed:
  // this is exactly the same trust boundary as sending from a real Gmail
  // account through any mail client.
  try {
    await withRetry(() => {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: gmailAppPassword },
      });
      return transporter.sendMail({
        from: `"Centro Website" <${gmailUser}>`,
        to,
        replyTo: email || undefined,
        subject: `פנייה חדשה מהאתר — ${name}`,
        html,
        text,
      });
    });
  } catch (err) {
    console.error(`[contact] Gmail send failed (ip=${ip})`, err);
    return NextResponse.json(
      { error: "שליחת ההודעה נכשלה. נסו שוב מאוחר יותר." },
      { status: 502 }
    );
  }

  console.log(`[contact] email sent successfully (ip=${ip}, source="${source}")`);

  try {
    await recordLeadAndSendWelcome({ name, phone, email, businessName, message, source });
  } catch (error) {
    console.error(`[contact] lead recording/WhatsApp welcome failed (ip=${ip})`, error);
  }

  return NextResponse.json({ status: "ok" });
}
