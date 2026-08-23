import nodemailer from "nodemailer";
import { withRetry } from "@/lib/resilience";

// Shared transactional sender, using the Gmail SMTP setup this project
// already runs on (src/app/api/contact/route.ts) — same credentials, same
// retry discipline, no new provider and no new dependency.
//
// Gmail always sends as the authenticated account regardless of the "from"
// address (anti-spoofing), so GMAIL_USER is both the auth identity and the
// visible sender; only the display NAME is ours to choose. That is exactly
// the same trust boundary as sending from a real Gmail account in any mail
// client — no domain verification or DNS records involved.
//
// The contact route is deliberately left untouched; this is an extraction
// for new callers, not a refactor of a working path.

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("GMAIL_USER / GMAIL_APP_PASSWORD are not configured.");
    this.name = "EmailNotConfiguredError";
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative — required for deliverability, never optional. */
  text: string;
}

// Throws on failure (including when unconfigured) so a caller can tell a
// real send apart from a silent no-op — which matters here, because the
// caller must NOT record "email sent" unless it genuinely was.
export async function sendTransactionalEmail(input: SendEmailInput): Promise<void> {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    throw new EmailNotConfiguredError();
  }

  await withRetry(() => {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailAppPassword },
    });
    return transporter.sendMail({
      from: `"Centro" <${gmailUser}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
  });
}
