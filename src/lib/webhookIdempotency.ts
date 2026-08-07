import { and, eq, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookMessageClaims } from "@/db/schema";

/**
 * Webhook idempotency/claim tracking — see webhook_message_claims's own
 * doc comment in schema.ts for the full incident this fixes (Meta
 * redelivering the same inbound message up to 4 times when a single
 * classification call ran long enough to hit the route's maxDuration).
 *
 * The contract: claimWebhookMessage must be called as the very first thing
 * the webhook route does for a message that carries a real WhatsApp
 * message id, before any expensive work (classification, AI calls,
 * outbound sends). Its result tells the caller exactly what to do next —
 * see ClaimResult below.
 */

// How long a "processing" claim is trusted to still be genuinely in
// flight. Comfortably longer than the webhook route's own maxDuration (30s)
// — if a claim is still "processing" past this, the attempt that made it
// almost certainly crashed or was killed by the platform, and the row is
// safe to reclaim rather than leaving the message stuck forever.
export const CLAIM_STALE_MS = 45_000;

export type ClaimResult =
  // Genuinely new — go ahead and process it. Also returned when a stale
  // ("failed", or "processing" past CLAIM_STALE_MS) claim was safely
  // reclaimed for a fresh attempt.
  | { outcome: "claimed"; claimId: string }
  // A different, still-live attempt already has this exact message and
  // hasn't finished yet — do nothing further; that attempt (or its own
  // eventual staleness-triggered reclaim) owns the outcome.
  | { outcome: "already_processing" }
  // This message already finished successfully — nothing left to do.
  | { outcome: "already_completed" };

// Atomic: a single INSERT ... ON CONFLICT DO NOTHING is the only way two
// concurrent redeliveries can never both believe they won the claim — one
// of them will always see zero rows returned and fall through to the
// "someone else has it" branch below, exactly the same compare-and-swap
// discipline already used elsewhere in this codebase (deferredReminderAt,
// pendingCaseReviewAt, flushDueIntakeNotifications).
export async function claimWebhookMessage(whatsappMessageId: string): Promise<ClaimResult> {
  const db = await getDb();

  const inserted = await db
    .insert(webhookMessageClaims)
    .values({ whatsappMessageId, status: "processing" })
    .onConflictDoNothing({ target: webhookMessageClaims.whatsappMessageId })
    .returning({ id: webhookMessageClaims.id });
  if (inserted.length > 0) {
    return { outcome: "claimed", claimId: inserted[0].id };
  }

  // Lost the insert race (or a genuine prior claim already exists) — look
  // at what's actually there to decide whether this is a real duplicate or
  // a stale/failed claim safe to retry.
  const [existing] = await db
    .select()
    .from(webhookMessageClaims)
    .where(eq(webhookMessageClaims.whatsappMessageId, whatsappMessageId))
    .limit(1);
  if (!existing) {
    // Vanishingly unlikely (the row we just lost the race for should
    // exist), but never assume — treat as "someone else has it" rather
    // than silently reprocessing.
    return { outcome: "already_processing" };
  }
  if (existing.status === "completed") {
    return { outcome: "already_completed" };
  }

  const staleThreshold = new Date(Date.now() - CLAIM_STALE_MS);
  const reclaimable = existing.status === "failed" || existing.claimedAt < staleThreshold;
  if (!reclaimable) {
    return { outcome: "already_processing" };
  }

  // Reclaim: atomic compare-and-swap on (whatsappMessageId, status/claimedAt
  // as last observed) — if another attempt reclaims it first, this UPDATE
  // matches zero rows and we correctly back off instead of double-processing.
  const reclaimed = await db
    .update(webhookMessageClaims)
    .set({ status: "processing", claimedAt: new Date(), completedAt: null, lastError: null })
    .where(
      and(
        eq(webhookMessageClaims.id, existing.id),
        or(eq(webhookMessageClaims.status, "failed"), lt(webhookMessageClaims.claimedAt, staleThreshold))
      )
    )
    .returning({ id: webhookMessageClaims.id });
  if (reclaimed.length === 0) {
    return { outcome: "already_processing" };
  }
  return { outcome: "claimed", claimId: reclaimed[0].id };
}

export async function markWebhookMessageCompleted(claimId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(webhookMessageClaims)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(webhookMessageClaims.id, claimId));
}

export async function markWebhookMessageFailed(claimId: string, error: unknown): Promise<void> {
  const db = await getDb();
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(webhookMessageClaims)
    .set({ status: "failed", lastError: message.slice(0, 2000) })
    .where(eq(webhookMessageClaims.id, claimId));
}
