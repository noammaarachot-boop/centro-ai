import { after } from "next/server";

/**
 * Thin, never-throwing wrapper around Next's `after()`.
 *
 * `after()` requires an active request scope (a Server Action or Route
 * Handler invocation) — every real production call path here (the WhatsApp
 * webhook route, or the "use server" simulateInboundMessage action) always
 * has one. Unit tests call the same business logic (documentIntakeReview.ts,
 * documentIdentityVerification.ts) directly with no request scope at all,
 * which makes `after()` throw ("called outside a request scope"). Falling
 * back to a no-op there — those tests call flushDueIntakeNotifications
 * explicitly instead of relying on the real delayed trigger — is safer than
 * letting that throw crash the whole request/test.
 */
export function scheduleAfterResponse(task: () => Promise<void> | void): void {
  try {
    after(task);
  } catch (error) {
    console.log(
      "[after] could not schedule background task (no active request scope — expected in tests)",
      error instanceof Error ? error.message : error
    );
  }
}
