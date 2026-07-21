import { NextResponse } from "next/server";
import { Resend } from "resend";

export const dynamic = "force-dynamic";

const NAME_MAX = 200;
const PHONE_PATTERN = /^[\d\s\-+()]{7,16}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ContactPayload {
  name: string;
  phone: string;
  email?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mirrors ContactForm's own client-side validation (src/components/landing/
// ContactForm.tsx) — required again here since the client check is only a
// UX convenience, never a security boundary.
function parsePayload(body: unknown): { value: ContactPayload } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "בקשה לא תקינה." };
  }
  const { name, phone, email } = body as Record<string, unknown>;

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

  return {
    value: {
      name: name.trim(),
      phone: phone.trim(),
      email: typeof email === "string" && email.trim() ? email.trim() : undefined,
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
  }

  const parsed = parsePayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { name, phone, email } = parsed.value;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[contact] RESEND_API_KEY is not configured");
    return NextResponse.json(
      { error: "שירות השליחה אינו זמין כרגע. נסו שוב מאוחר יותר." },
      { status: 503 }
    );
  }

  const to = process.env.CONTACT_EMAIL_TO || "Centro.ai.team@gmail.com";
  const from = process.env.RESEND_FROM_EMAIL || "Centro Website <onboarding@resend.dev>";

  const submittedAt = new Date().toLocaleString("he-IL", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Jerusalem",
  });

  const rows: Array<[string, string]> = [
    ["שם מלא", name],
    ["טלפון", phone],
    ["אימייל", email || "לא סופק"],
    ["תאריך ושעה", submittedAt],
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
                <td style="padding: 10px 0 10px 16px; border-bottom: 1px solid #efeefa; color: #1c1a2b; font-size: 14px;">${escapeHtml(value)}</td>
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

  const resend = new Resend(apiKey);

  try {
    const { error } = await resend.emails.send({
      from,
      to,
      replyTo: email || undefined,
      subject: `פנייה חדשה מהאתר — ${name}`,
      html,
      text,
    });

    if (error) {
      console.error("[contact] Resend rejected the send", error);
      return NextResponse.json(
        { error: "שליחת ההודעה נכשלה. נסו שוב מאוחר יותר." },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("[contact] Resend request failed", err);
    return NextResponse.json(
      { error: "שליחת ההודעה נכשלה. נסו שוב מאוחר יותר." },
      { status: 502 }
    );
  }

  return NextResponse.json({ status: "ok" });
}
