import nodemailer from "nodemailer";
import { withRetry } from "@/lib/resilience";

/**
 * Password reset email — real delivery via the same Gmail SMTP mechanism
 * already used and already configured in production for the marketing
 * site's contact form (src/app/api/contact/route.ts's GMAIL_USER/
 * GMAIL_APP_PASSWORD), reused here rather than introducing a second email
 * provider/credential for the same job.
 *
 * Never throws — a transient send failure must never turn into an error
 * response that reveals (via a different response shape than the generic
 * "if that email exists" state) whether the account existed. Logs loudly
 * on failure instead, since a silently-lost reset email is otherwise
 * invisible.
 *
 * The link is deliberately never returned to the caller or exposed in any
 * HTTP response — only ever placed in the email body itself.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    console.error("[password-reset] GMAIL_USER / GMAIL_APP_PASSWORD is not configured — reset email NOT sent", { email });
    return;
  }

  const html = `
    <div dir="rtl" style="font-family: Arial, Helvetica, sans-serif; background: #f5f4fb; padding: 32px 16px;">
      <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e6e4f2;">
        <div style="background: linear-gradient(135deg, #7c3aed, #3b6dff); padding: 24px 28px;">
          <h1 style="margin: 0; color: #ffffff; font-size: 18px; font-weight: 700;">איפוס סיסמה ל-Centro</h1>
        </div>
        <div style="padding: 24px 28px;">
          <p style="margin: 0 0 20px; color: #1c1a2b; font-size: 14px; line-height: 1.6;">
            התקבלה בקשה לאיפוס הסיסמה שלך. הקישור בתוקף לשעה אחת מרגע קבלת המייל הזה.
          </p>
          <p style="margin: 0 0 24px;">
            <a href="${resetUrl}" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;">איפוס סיסמה</a>
          </p>
          <p style="margin: 0; color: #9b98ad; font-size: 12px;">
            אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהמייל הזה.
          </p>
        </div>
      </div>
    </div>
  `.trim();
  const text = `התקבלה בקשה לאיפוס הסיסמה שלך ל-Centro. הקישור בתוקף לשעה אחת:\n${resetUrl}\n\nאם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהמייל הזה.`;

  try {
    await withRetry(() => {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: gmailAppPassword },
      });
      return transporter.sendMail({
        from: `"Centro" <${gmailUser}>`,
        to: email,
        subject: "איפוס סיסמה ל-Centro",
        html,
        text,
      });
    });
  } catch (error) {
    console.error("[password-reset] Gmail send failed", error);
  }
}
