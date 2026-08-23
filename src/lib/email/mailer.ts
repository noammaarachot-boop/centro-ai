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
  /**
   * Display name only. Gmail always sends as the authenticated account, so
   * this cannot change who the mail is actually from — "Centro Support" and
   * "Centro Website" are labels on the same mailbox.
   */
  fromName?: string;
  /** Where a human reply should go, when that is not the Centro mailbox. */
  replyTo?: string;
}

/**
 * Whether outbound email can be sent at all.
 *
 * Exists so a caller can check BEFORE doing user-specific work. The
 * forgot-password flow needs exactly this: if email is unconfigured it must
 * fail the same way for every address, because failing only for addresses
 * that belong to a real account would turn an outage into a user-enumeration
 * oracle.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
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
      from: `"${input.fromName ?? "Centro"}" <${gmailUser}>`,
      to: input.to,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
  });
}
