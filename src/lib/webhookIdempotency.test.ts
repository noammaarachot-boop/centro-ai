import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Webhook message claim idempotency — the real production bug this closes:
// Meta redelivered the same inbound message up to 4 times because a single
// attempt's AI classification ran long enough to hit the route's
// maxDuration. These tests cover exactly the guarantees the fix depends on:
// a genuine race can never double-claim, a still-live "processing" claim
// blocks a redelivery, a claim that finished (completed) is never reopened,
// and a claim that died mid-flight (failed, or stuck past staleness) can
// always be recovered rather than permanently locking the message out.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { claimWebhookMessage, markWebhookMessageCompleted, markWebhookMessageFailed, CLAIM_STALE_MS } = await import(
  "./webhookIdempotency"
);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.webhookMessageClaims);
});

describe("claimWebhookMessage", () => {
  it("claims a genuinely new message id", async () => {
    const result = await claimWebhookMessage("wamid.new-1");
    expect(result.outcome).toBe("claimed");
  });

  it("never lets two concurrent claims on the same message id both win (Meta redelivery race)", async () => {
    const results = await Promise.all([
      claimWebhookMessage("wamid.race-1"),
      claimWebhookMessage("wamid.race-1"),
      claimWebhookMessage("wamid.race-1"),
      claimWebhookMessage("wamid.race-1"),
    ]);
    const claimedCount = results.filter((r) => r.outcome === "claimed").length;
    expect(claimedCount).toBe(1);
    const skippedCount = results.filter((r) => r.outcome === "already_processing").length;
    expect(skippedCount).toBe(3);
  });

  it("refuses a second claim while the first attempt is still live (processing, not stale)", async () => {
    const first = await claimWebhookMessage("wamid.live-1");
    expect(first.outcome).toBe("claimed");
    const second = await claimWebhookMessage("wamid.live-1");
    expect(second.outcome).toBe("already_processing");
  });

  it("refuses reprocessing once a message already completed successfully", async () => {
    const first = await claimWebhookMessage("wamid.done-1");
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    await markWebhookMessageCompleted(first.claimId);

    const redelivery = await claimWebhookMessage("wamid.done-1");
    expect(redelivery.outcome).toBe("already_completed");
  });

  it("allows reclaiming a failed claim (recovery after a genuine processing error)", async () => {
    const first = await claimWebhookMessage("wamid.failed-1");
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    await markWebhookMessageFailed(first.claimId, new Error("boom"));

    const retry = await claimWebhookMessage("wamid.failed-1");
    expect(retry.outcome).toBe("claimed");
    if (retry.outcome === "claimed") {
      // Reclaiming reuses the same row (same whatsapp_message_id is unique)
      // — never creates a second row for the same message.
      expect(retry.claimId).toBe(first.claimId);
    }
  });

  it("allows reclaiming a stale 'processing' claim (the attempt that made it crashed/was killed by the platform)", async () => {
    const first = await claimWebhookMessage("wamid.stale-1");
    if (first.outcome !== "claimed") throw new Error("expected claimed");

    // Simulate the claim having gone stale — back-date claimedAt past
    // CLAIM_STALE_MS, exactly what a crashed/killed attempt would leave
    // behind (a "processing" row that never transitions to completed/failed).
    await db
      .update(schema.webhookMessageClaims)
      .set({ claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 1_000) })
      .where(eq(schema.webhookMessageClaims.id, first.claimId));

    const reclaimed = await claimWebhookMessage("wamid.stale-1");
    expect(reclaimed.outcome).toBe("claimed");
  });

  it("does NOT allow reclaiming a 'processing' claim that is still within the staleness window", async () => {
    const first = await claimWebhookMessage("wamid.fresh-1");
    if (first.outcome !== "claimed") throw new Error("expected claimed");

    // Only slightly old — well under CLAIM_STALE_MS, so the original
    // attempt could still genuinely be in flight.
    await db
      .update(schema.webhookMessageClaims)
      .set({ claimedAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.webhookMessageClaims.id, first.claimId));

    const second = await claimWebhookMessage("wamid.fresh-1");
    expect(second.outcome).toBe("already_processing");
  });

  it("never lets two concurrent reclaim attempts on the same stale row both win", async () => {
    const first = await claimWebhookMessage("wamid.stale-race-1");
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    await db
      .update(schema.webhookMessageClaims)
      .set({ claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 1_000) })
      .where(eq(schema.webhookMessageClaims.id, first.claimId));

    const results = await Promise.all([
      claimWebhookMessage("wamid.stale-race-1"),
      claimWebhookMessage("wamid.stale-race-1"),
    ]);
    const claimedCount = results.filter((r) => r.outcome === "claimed").length;
    expect(claimedCount).toBe(1);
  });

  it("treats different message ids as fully independent", async () => {
    const a = await claimWebhookMessage("wamid.independent-a");
    const b = await claimWebhookMessage("wamid.independent-b");
    expect(a.outcome).toBe("claimed");
    expect(b.outcome).toBe("claimed");
  });
});
