import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Regression — the database, not a check-then-send, decides.
 *
 * Every protection before this was "read a row, decide it is due, then
 * send". Two ticks, two workers, a retry or a double-click could all pass
 * that check before any of them wrote. Production shows the outcome: one
 * client received the same reminder text seven separate times.
 *
 * The property here is stronger than "the scheduler does not loop": even
 * with the loop fixed, a duplicate INVOCATION must not produce a duplicate
 * message. The unique index on messages.idempotencyKey is what guarantees
 * it, so these tests drive sendOutboundMessage directly — including truly
 * concurrently — rather than through the scheduler that normally supplies
 * the key.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
    sendTemplateMessage: vi.fn(),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});
vi.mock("@/lib/whatsapp/tokenCipher", () => ({ decryptWhatsAppToken: () => "token" }));

const { sendOutboundMessage } = await import("@/lib/conversationOrchestration");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let conversationId: string;
let seq = 0;

beforeEach(async () => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.ok" });

  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      documentCollectionEnabled: true,
      whatsappPhoneNumberId: `phone-${(seq += 1)}-${Date.now()}`,
      whatsappAccessTokenEnc: "enc",
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000111" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
    .returning();
  orgId = org.id;
  conversationId = conversation.id;
});

const outbound = async () =>
  db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));

describe("idempotency key — a logical message can only be sent once", () => {
  it("suppresses a second call with the same key", async () => {
    const key = `reminder:${conversationId}:cycle-1`;

    const first = await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key);
    const second = await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key);

    expect(first.sent).toBe(true);
    expect(second.sent, "the duplicate must not be sent").toBe(false);
    expect(second.deliveryStatus).toBe("duplicate_suppressed");
    expect(sendTextMessage, "the provider must be called exactly once").toHaveBeenCalledTimes(1);
    expect(await outbound()).toHaveLength(1);
  });

  it("suppresses duplicates even when the calls race concurrently", async () => {
    const key = `reminder:${conversationId}:cycle-race`;

    // Five workers, no ordering, no coordination between them.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key)
      )
    );

    expect(results.filter((r) => r.sent), "exactly one winner").toHaveLength(1);
    expect(sendTextMessage, "four losers must stop before reaching the provider").toHaveBeenCalledTimes(1);
    expect(await outbound()).toHaveLength(1);
  });

  it("still sends once the next cycle brings a new key", async () => {
    await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, `k:${conversationId}:1`);
    await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, `k:${conversationId}:2`);

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(await outbound(), "a genuinely new cycle is a new message").toHaveLength(2);
  });

  it("does not deduplicate deliberate human sends, which carry no key", async () => {
    // Two identical messages an employee actually typed are two messages.
    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");
    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(await outbound()).toHaveLength(2);
  });

  it("keeps the key on the row, so a duplicate is still provable afterwards", async () => {
    const key = `reminder:${conversationId}:cycle-9`;
    await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key);

    const rows = await outbound();
    expect(rows[0].idempotencyKey).toBe(key);
  });

  it("a suppressed duplicate never reports itself as sent", async () => {
    const key = `reminder:${conversationId}:cycle-x`;
    await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key);
    const dup = await sendOutboundMessage(orgId, conversationId, "תזכורת", "ai", "manual", undefined, true, undefined, key);

    // The caller must be able to tell "already handled" from "delivered".
    expect(dup.sent).toBe(false);
    expect(dup.deliveryStatus).not.toBe("sent");
  });
});
