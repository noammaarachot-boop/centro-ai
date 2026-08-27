import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { seedApprovedWhatsAppTemplates } from "@/test/whatsappFixtures";

/**
 * Regression — "sent" must mean the provider accepted it.
 *
 * sendOutboundMessage used to return sent:true for any attempt the
 * automation gate let through, including ones WhatsApp refused.
 * attemptScheduledDelivery believed it, flipped the request to `active`
 * and wrote the audit line "בקשת האיסוף נשלחה ללקוח" for clients who
 * received nothing. Three production requests are in exactly that state
 * (114, 168 and 228 message rows, zero provider-accepted between them).
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

// The transport itself is what decides success, so it is the seam.
const sendTextMessage = vi.fn();
const sendTemplateMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
    sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});
vi.mock("@/lib/whatsapp/tokenCipher", () => ({ decryptWhatsAppToken: () => "token" }));

const { sendOutboundMessage } = await import("@/lib/conversationOrchestration");
const { WhatsAppSendError } = await import("@/lib/whatsapp/send");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let conversationId: string;
let seq = 0;

beforeEach(async () => {
  sendTextMessage.mockReset();
  sendTemplateMessage.mockReset();

  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      documentCollectionEnabled: true,
      whatsappPhoneNumberId: `phone-${(seq += 1)}-${Date.now()}`,
      whatsappAccessTokenEnc: "enc",
    })
    .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
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

describe("sendOutboundMessage — sent means the provider accepted it", () => {
  it("reports sent:false when the provider refuses", async () => {
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("Message failed to send: (#131047) Re-engagement message"));

    const result = await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    expect(result.sent, "a refused send must never report success").toBe(false);
    expect(result.deliveryStatus).toBe("failed");
  });

  it("reports sent:true only when the provider accepted it", async () => {
    sendTextMessage.mockResolvedValue({ messageId: "wamid.ok" });

    const result = await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    expect(result.sent).toBe(true);
    expect(result.deliveryStatus).toBe("sent");
  });

  it("records the refusal on the message row, not a delivered-looking one", async () => {
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("Message failed to send: (#131047)"));

    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryStatus).toBe("failed");
    expect(rows[0].whatsappMessageId, "a refused message has no provider id").toBeNull();
  });

  it("keeps the provider's reason in the audit trail for debugging", async () => {
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("Message failed to send: (#131047) Re-engagement message"));

    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "whatsapp.outbound_send_failed"), eq(schema.auditLogs.organizationId, orgId)));
    expect(events).toHaveLength(1);
    const metadata = events[0].metadata as { failureReason?: string };
    expect(metadata.failureReason, "the reason a send failed is the point of the record").toContain("131047");
  });

  it("never writes a raw phone number into the failure reason", async () => {
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("failed for +972501234567 (#131047)"));

    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "whatsapp.outbound_send_failed"), eq(schema.auditLogs.organizationId, orgId)));
    const metadata = events[0].metadata as { failureReason?: string };
    expect(metadata.failureReason).not.toContain("972501234567");
    expect(metadata.failureReason).toContain("[phone]");
  });

  it("still reports sent:false — with no message row's status claiming otherwise — when the org has no WhatsApp connected", async () => {
    await db
      .update(schema.organizations)
      .set({ whatsappPhoneNumberId: null })
      .where(eq(schema.organizations.id, orgId));

    const result = await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    expect(result.sent).toBe(false);
    expect(result.deliveryStatus).toBe("not_connected");
    expect(sendTextMessage, "nothing should reach the provider").not.toHaveBeenCalled();
  });
});

/**
 * Every failure mode, not just the one the code names.
 *
 * sendViaWhatsApp used to rethrow anything that was not a WhatsAppSendError
 * or an OperationFailedError. A socket timeout, a DNS failure or a
 * truncated response that blows up on parse therefore escaped: the
 * finalizing UPDATE never ran, the row stayed "pending" forever with no
 * recorded reason, and the throw propagated out of sendOutboundMessage —
 * far enough to abort the rest of a scheduler tick, other organizations
 * included.
 */
describe("sendOutboundMessage — unexpected transport failures", () => {
  const cases: Array<[string, unknown]> = [
    ["a socket timeout", Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["a DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND graph.facebook.com"), { code: "ENOTFOUND" })],
    ["a truncated/partial response", new SyntaxError("Unexpected end of JSON input")],
    ["an unexpected programming error", new TypeError("Cannot read properties of undefined (reading 'messages')")],
  ];

  for (const [label, thrown] of cases) {
    it(`records ${label} as failed instead of throwing`, async () => {
      sendTextMessage.mockRejectedValue(thrown);

      // The contract is "never throws, always records".
      const result = await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

      expect(result.sent, `${label} must never report success`).toBe(false);
      expect(result.deliveryStatus).toBe("failed");

      const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
      expect(rows, "exactly one row, and it must not be left pending").toHaveLength(1);
      expect(rows[0].deliveryStatus).toBe("failed");
      expect(rows[0].whatsappMessageId).toBeNull();
    });
  }

  it("leaves no message stuck at pending after an unexpected failure", async () => {
    sendTextMessage.mockRejectedValue(new TypeError("boom"));
    await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    const pending = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.deliveryStatus, "pending")));
    expect(pending, "a pending row with no resolution is a phantom message").toHaveLength(0);
  });

  it("a provider response with no message id is not treated as delivered", async () => {
    // A 200 that carries nothing usable is not an acceptance.
    sendTextMessage.mockResolvedValue({});
    const result = await sendOutboundMessage(orgId, conversationId, "שלום", "employee");

    const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(rows[0].whatsappMessageId ?? null, "no provider id was returned").toBeNull();
    // Whatever the status, it must not claim a provider id it never got.
    expect(result.deliveryStatus === "sent" && rows[0].whatsappMessageId === null).toBe(false);
  });
});
