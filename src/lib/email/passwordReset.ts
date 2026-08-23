import { sendTransactionalEmail } from "./mailer";

/**
 * Password reset email, sent through the shared transactional mailer.
 *
 * THROWS on failure, and that is the point.
 *
 * This used to swallow every failure — both "email is not configured" and
 * "the send itself failed" — logging and returning normally. The intent was
 * anti-enumeration: never let a failure produce a different response than
 * the generic "if that address exists, we sent a link" state.
 *
 * The intent was right; the layer was wrong. Swallowing here meant a user
 * locked out of their account saw "check your inbox", received nothing, and
 * had no other route back in — the reset flow reported success while being
 * completely non-functional. Enumeration is a property of what the ACTION
 * tells the user, so the action now owns it (see
 * src/app/forgot-password/actions.ts, which checks configuration up front,
 * before it knows whether the account exists, and answers identically for
 * every address). This function's only job is to report the truth.
 *
 * The link is deliberately never returned to the caller or exposed in any
 * HTTP response — only ever placed in the email body itself.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {

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

  await sendTransactionalEmail({
    to: email,
    subject: "איפוס סיסמה ל-Centro",
    html,
    text,
  });
}
