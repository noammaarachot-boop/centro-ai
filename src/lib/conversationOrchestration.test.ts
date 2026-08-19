import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Phase 2.1 remediation coverage — the per-organization Meta
 * template-approval gate replacing the old global INITIAL_REQUEST_V2_ENABLED
 * flag, plus the automatic v1 fallback when Meta rejects a v2 send (e.g. a
 * stale/premature organizations.initialRequestV2Approved). No prior test
 * file existed for this module at all.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
const sendTemplateMessage = vi.fn();
const sendInteractiveButtonsMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
    sendInteractiveButtonsMessage: (...args: unknown[]) => sendInteractiveButtonsMessage(...args),
  };
});

const { startConversation, sendOutboundMessage, ensureConversation, recordInboundMessage } = await import(
  "./conversationOrchestration"
);
const { WhatsAppSendError } = await import("./whatsapp/send");
const { encryptWhatsAppToken } = await import("./whatsapp/tokenCipher");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTemplateMessage.mockReset();
  sendInteractiveButtonsMessage.mockReset();
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

async function seedRequest(initialRequestV2Approved: boolean) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      initialRequestV2Approved,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח בדיקה", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
  return { orgId: org.id, clientId: client.id, requestId: request.id };
}

describe("startConversation — Phase 2.1: template v2 usage is gated per-organization", () => {
  it("organization has NOT approved v2 — sends the static v1 template, never guesses approval", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.1" });

    await startConversation(orgId, requestId, clientId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage.mock.calls[0][2]).toBe("centro_initial_request");
    expect(sendTemplateMessage.mock.calls[0][4]).toEqual([]);
  });

  it("organization HAS approved v2 — sends the dynamic v2 template with the real requirement list", async () => {
    const { orgId, clientId, requestId } = await seedRequest(true);
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.1" });

    await startConversation(orgId, requestId, clientId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage.mock.calls[0][2]).toBe("centro_initial_request_v2");
    expect(sendTemplateMessage.mock.calls[0][4]).toEqual(["תעודת זהות"]);
  });

  it("v2 approved but Meta rejects the send (e.g. stale approval flag) — falls back to v1 automatically, client still gets a real message", async () => {
    const { orgId, clientId, requestId } = await seedRequest(true);
    const { WhatsAppSendError } = await import("@/lib/whatsapp/send");
    sendTemplateMessage.mockRejectedValueOnce(new WhatsAppSendError("simulated: template not approved on this WABA"));
    sendTemplateMessage.mockResolvedValueOnce({ messageId: "wamid.fallback" });

    const result = await startConversation(orgId, requestId, clientId);

    expect(result.sent).toBe(true);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(sendTemplateMessage.mock.calls[0][2]).toBe("centro_initial_request_v2"); // first attempt
    expect(sendTemplateMessage.mock.calls[1][2]).toBe("centro_initial_request"); // fallback

    // Both attempts are on the record — nothing hidden — and the LAST
    // message is the one that actually reached the client.
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, result.conversation.id)).orderBy(schema.messages.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0].deliveryStatus).toBe("failed");
    expect(rows[1].deliveryStatus).toBe("sent");
    expect(rows[1].whatsappMessageId).toBe("wamid.fallback");
  });

  it("never retries more than once — a second v1 failure is not looped", async () => {
    const { orgId, clientId, requestId } = await seedRequest(true);
    const { WhatsAppSendError } = await import("@/lib/whatsapp/send");
    sendTemplateMessage.mockRejectedValue(new WhatsAppSendError("simulated: total outage"));

    const result = await startConversation(orgId, requestId, clientId);

    expect(result.sent).toBe(true); // sendOutboundMessage's own contract: recorded, not gated — even though delivery failed
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2); // v2 attempt + exactly one v1 fallback, never more
  });
});

// Manual per-organization WhatsApp connection — sendViaWhatsApp must decrypt
// organization.whatsappAccessTokenEnc (when the owner connected the office
// manually) and pass it through to the Graph API call as the trailing
// accessToken argument, instead of always relying on the shared
// WHATSAPP_SYSTEM_USER_TOKEN. An organization connected the existing
// Embedded Signup way (whatsappAccessTokenEnc is null) must keep passing
// undefined, i.e. behave exactly as before this feature existed.
describe("startConversation — manual per-organization Access Token", () => {
  it("an organization with a manually-connected Access Token: it is decrypted and passed to sendTemplateMessage", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    await db
      .update(schema.organizations)
      .set({ whatsappAccessTokenEnc: encryptWhatsAppToken("EAAG_org_own_token") })
      .where(eq(schema.organizations.id, orgId));
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.1" });

    await startConversation(orgId, requestId, clientId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage.mock.calls[0][5]).toBe("EAAG_org_own_token");
  });

  it("an organization with no manual connection (Embedded Signup / whatsappAccessTokenEnc null): passes undefined, unchanged behavior", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.1" });

    await startConversation(orgId, requestId, clientId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage.mock.calls[0][5]).toBeUndefined();
  });
});

describe("sendOutboundMessage — deliveryStatus is exposed to the caller (additive)", () => {
  it("returns the real deliveryStatus alongside sent, without breaking callers that only destructure { sent }", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId })
      .returning();
    sendTextMessage.mockResolvedValue({ messageId: "wamid.employee" });

    const result = await sendOutboundMessage(orgId, conversation.id, "הודעה חופשית", "employee");

    expect(result).toEqual({ sent: true, deliveryStatus: "sent" });
  });
});

describe("sendOutboundMessage — Phase 3.1: the message row exists (and conversations.updatedAt is already bumped) BEFORE the Meta call, not just after", () => {
  it("a message row with deliveryStatus 'pending' is already queryable at the moment the Meta call is made — proves insert-before-send, not send-before-insert", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, updatedAt: new Date(0) })
      .returning();

    let sawPendingRowDuringSend: boolean | null = null;
    let sawBumpedConversationDuringSend: boolean | null = null;
    sendTextMessage.mockImplementation(async () => {
      // Peek at real DB state from *inside* the mocked Meta call — this is
      // exactly the moment a real crash (function killed mid-flight) would
      // leave things frozen. If the fix is in place, both the message row
      // and the conversation bump already exist right here, before Meta
      // has even "responded".
      const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
      sawPendingRowDuringSend = rows.length === 1 && rows[0].deliveryStatus === "pending" && rows[0].whatsappMessageId === null;
      const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
      sawBumpedConversationDuringSend = conv.updatedAt.getTime() > 0;
      return { messageId: "wamid.mid-flight" };
    });

    await sendOutboundMessage(orgId, conversation.id, "test", "employee");

    expect(sawPendingRowDuringSend).toBe(true);
    expect(sawBumpedConversationDuringSend).toBe(true);

    // And by the time the call has fully returned, the row is no longer
    // stuck at pending — it reflects the real, final outcome.
    const finalRows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].deliveryStatus).toBe("sent");
    expect(finalRows[0].whatsappMessageId).toBe("wamid.mid-flight");
  });

  it("a real crash mid-send (Meta call throws) still leaves a queryable audit row and an already-bumped conversation — never silent data loss", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, updatedAt: new Date(0) })
      .returning();
    sendTextMessage.mockRejectedValue(new Error("simulated hard crash — not even a WhatsAppSendError"));

    // sendViaWhatsApp only catches WhatsAppSendError/OperationFailedError —
    // an unexpected error type rethrows, simulating a genuine crash rather
    // than a normal "Meta rejected it" failure.
    await expect(sendOutboundMessage(orgId, conversation.id, "test", "employee")).rejects.toThrow();

    const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryStatus).toBe("pending"); // never updated — the crash happened before that was possible
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    expect(conv.updatedAt.getTime()).toBeGreaterThan(0); // already bumped before the crash — a later scheduler tick won't treat this as untouched
  });
});

// Observability remediation — sendOutboundMessage is the single guaranteed
// source of an audit_logs row for every send attempt, regardless of which
// caller invoked it or whether that caller does its own additional
// logging. Covers every exit path: blocked by the automation gate, a
// genuine send (success and failure), and "not connected".
describe("sendOutboundMessage — observability remediation: an audit_logs row for every exit path", () => {
  it("blocked by the automation gate — records whatsapp.send_blocked with the collectionRequestId and reason, and creates no messages row at all", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    await db.update(schema.organizations).set({ documentCollectionEnabled: false }).where(eq(schema.organizations.id, orgId));
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId })
      .returning();

    const result = await sendOutboundMessage(orgId, conversation.id, "טקסט", "ai", "automated");
    expect(result).toEqual({ sent: false });

    const messageRows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
    expect(messageRows).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe("whatsapp.send_blocked");
  });

  it("a genuine successful send — records whatsapp.send_completed with the messageId and deliveryStatus in metadata", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId })
      .returning();
    sendTextMessage.mockResolvedValue({ messageId: "wamid.ok" });

    await sendOutboundMessage(orgId, conversation.id, "הודעה חופשית", "employee");

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe("whatsapp.send_completed");
    const metadata = auditRows[0].metadata as Record<string, unknown>;
    expect(metadata.deliveryStatus).toBe("sent");
    expect(metadata.whatsappMessageId).toBe("wamid.ok");
    expect(typeof metadata.messageId).toBe("string");
  });

  it("not connected (no whatsappPhoneNumberId) — records whatsapp.send_failed with deliveryStatus 'not_connected'", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    await db.update(schema.organizations).set({ whatsappPhoneNumberId: null }).where(eq(schema.organizations.id, orgId));
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId })
      .returning();

    await sendOutboundMessage(orgId, conversation.id, "הודעה חופשית", "employee");

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe("whatsapp.send_failed");
    expect((auditRows[0].metadata as Record<string, unknown>).deliveryStatus).toBe("not_connected");
  });

  it("a real Meta rejection (WhatsAppSendError) — still records whatsapp.send_failed (alongside the existing whatsapp.outbound_send_failed signal)", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId })
      .returning();
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("recipient not on WhatsApp"));

    await sendOutboundMessage(orgId, conversation.id, "הודעה חופשית", "employee");

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    const eventTypes = auditRows.map((r) => r.eventType);
    expect(eventTypes).toContain("whatsapp.send_failed");
  });
});

// Reminder-lifecycle root-cause fix (2026-08-16 production incident) — a
// request the client never responds to at all previously had no 3-day
// escalation clock, since reviewDeadlineAt was only ever set on entry into
// waiting_for_client or on an explicit deferral resolving — neither of
// which a silent request ever reaches. Set once, here, at the real moment
// a conversation first exists for a request.
describe("ensureConversation — sets a 3-day reviewDeadlineAt at the real moment a request is first sent", () => {
  it("a brand-new conversation gets reviewDeadlineAt ~3 days out, anchored to the real creation moment", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const before = Date.now();

    await ensureConversation(orgId, requestId, clientId);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.reviewDeadlineAt).not.toBeNull();
    const deltaMs = request.reviewDeadlineAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThan(2.9 * 24 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThan(3.1 * 24 * 60 * 60 * 1000);
  });

  it("calling it again for the same request (conversation already exists) never overwrites an already-set reviewDeadlineAt", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    await ensureConversation(orgId, requestId, clientId);
    const [first] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));

    await ensureConversation(orgId, requestId, clientId);
    const [second] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));

    expect(second.reviewDeadlineAt!.getTime()).toBe(first.reviewDeadlineAt!.getTime());
  });

  it("never overwrites a reviewDeadlineAt that was already explicitly set before the conversation existed (defensive IS NULL guard)", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const explicitDeadline = new Date(Date.now() + 60 * 60 * 1000); // an unusual, already-set value
    await db.update(schema.collectionRequests).set({ reviewDeadlineAt: explicitDeadline }).where(eq(schema.collectionRequests.id, requestId));

    await ensureConversation(orgId, requestId, clientId);

    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.reviewDeadlineAt!.getTime()).toBe(explicitDeadline.getTime());
  });

  it("startConversation (the real send path) also gets a reviewDeadlineAt through this same mechanism, with no extra wiring needed", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.out" });

    await startConversation(orgId, requestId, clientId, "manual");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.reviewDeadlineAt).not.toBeNull();
  });
});

describe("recordInboundMessage — whatsappMessageId is persisted, not silently dropped", () => {
  it("stores the given whatsappMessageId on the inbound message row when the caller has one (a real attachment)", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const conversation = await ensureConversation(orgId, requestId, clientId);

    await recordInboundMessage(orgId, conversation.id, "[קובץ מצורף]", "wamid.inbound-attachment-1");

    const [row] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id));
    expect(row.whatsappMessageId).toBe("wamid.inbound-attachment-1");
  });

  it("leaves whatsappMessageId null for a plain text inbound message (no id given), same as before", async () => {
    const { orgId, clientId, requestId } = await seedRequest(false);
    const conversation = await ensureConversation(orgId, requestId, clientId);

    await recordInboundMessage(orgId, conversation.id, "סיימתי");

    const [row] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id));
    expect(row.whatsappMessageId).toBeNull();
  });
});
