/**
 * Password reset email — mocked but real interface. No live email provider
 * (SMTP, SES, Resend, etc.) is configured in this environment, matching
 * this codebase's established pattern for pilot-stage external
 * dependencies (see src/lib/ai/documentClassifier.ts and
 * businessTypeClassifier.ts for the same shape of stand-in). This function
 * is genuinely async and has the exact interface a real provider call
 * would have, so swapping one in later means changing only this file, not
 * any caller.
 *
 * In this environment, "sending" means logging the reset link server-side
 * for pilot testability. The link is deliberately never returned to the
 * caller or exposed in any HTTP response — the forgot-password action's
 * generic "if that email exists" response must hold regardless of what
 * this function does internally.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  console.log(`[password-reset] Would send reset email to ${email}: ${resetUrl}`);
}
