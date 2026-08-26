import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

/**
 * Regression — production, 26.8.2026.
 *
 * "שליחה חוזרת" was pressed on a failed reminder and the send failed again
 * with Meta's "(#100) Invalid parameter". The retry was wrong by
 * construction: the message that failed was a TEMPLATE send (senderType
 * "ai"), and the retry re-sent its body as employee free text. WhatsApp only
 * accepts free text inside the 24-hour window a client message opens, and
 * this client had never written in — so the retry could not have succeeded
 * on the first attempt or the thousandth.
 *
 * The property under test is therefore not "retry works" but "a retry is
 * the SAME KIND of send as the message it is retrying".
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => currentSession) }));

vi.mock("next/cache", () => ({ refresh: vi.fn() }));

const sendOutboundMessage = vi.fn();
vi.mock("@/lib/conversationOrchestration", async () => {
  const actual = await vi.importActual<typeof import("@/lib/conversationOrchestration")>(
    "@/lib/conversationOrchestration"
  );
  return { ...actual, sendOutboundMessage: (...args: unknown[]) => sendOutboundMessage(...args) };
});

const { retryFailedMessage } = await import("./conversationActions");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let requestId: string;
let conversationId: string;

/** Puts a failed outbound message of the given kind at the end of the thread. */
async function givenFailedOutbound(senderType: "ai" | "employee") {
  const [message] = await db
    .insert(schema.messages)
    .values({
      organizationId: currentSession.organizationId,
      conversationId,
      direction: "outbound",
      senderType,
      body: "שלום,\n\nרצינו להזכיר שעדיין חסרים המסמכים",
      deliveryStatus: "failed",
    })
    .returning();
  return message;
}

beforeEach(async () => {
  sendOutboundMessage.mockReset();
  sendOutboundMessage.mockResolvedValue({ sent: true, deliveryStatus: "sent", failureReason: null });

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", reminderV2Approved: true })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `o-${Date.now()}-${Math.random()}@example.com`, passwordHash: "x" })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "נועם", phone: "+972500000111" })
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

  // A reminder exists BECAUSE something is missing — buildReminderSend only
  // produces a template when it has a document list to put in it.
  await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" });

  requestId = request.id;
  conversationId = conversation.id;
  currentSession = {
    userId: user.id,
    organizationId: org.id,
    organizationName: "Org",
    email: user.email,
  } as unknown as Session;
});

/** sendOutboundMessage(orgId, conversationId, body, senderType, …, key) */
const senderTypeOf = () => sendOutboundMessage.mock.calls[0][3];
const idempotencyKeyOf = () => sendOutboundMessage.mock.calls[0][8];

describe("retrying a failed message", () => {
  it("retries a template send AS a template send, not as free text", async () => {
    await givenFailedOutbound("ai");

    const result = await retryFailedMessage(requestId, {}, new FormData());

    expect(result.error).toBeUndefined();
    expect(sendOutboundMessage).toHaveBeenCalledTimes(1);
    expect(senderTypeOf(), "sending this as employee free text is what Meta refused").toBe("ai");
  });

  it("carries a template descriptor, since the reminder body never matches a template verbatim", async () => {
    await givenFailedOutbound("ai");
    await retryFailedMessage(requestId, {}, new FormData());

    const templateSend = sendOutboundMessage.mock.calls[0][5];
    expect(templateSend, "a template send with no template is just free text again").toBeTruthy();
  });

  it("keys the retry to the message that failed, so a double-click cannot send twice", async () => {
    const failed = await givenFailedOutbound("ai");
    await retryFailedMessage(requestId, {}, new FormData());

    expect(idempotencyKeyOf()).toBe(`retry:${failed.id}`);
  });

  it("reports a repeat failure in plain language, leaking no internal status name", async () => {
    await givenFailedOutbound("ai");
    sendOutboundMessage.mockResolvedValueOnce({
      sent: false,
      deliveryStatus: "no_template",
      failureReason: "WhatsApp send failed (400): code=100",
    });

    const result = await retryFailedMessage(requestId, {}, new FormData());

    expect(result.error).toBeTruthy();
    for (const jargon of ["no_template", "failed", "code=100", "400"]) {
      expect(result.error, jargon).not.toContain(jargon);
    }
  });

  it("does not claim success when the send was suppressed as a duplicate", async () => {
    await givenFailedOutbound("ai");
    sendOutboundMessage.mockResolvedValueOnce({ sent: false, deliveryStatus: "duplicate_suppressed" });

    const result = await retryFailedMessage(requestId, {}, new FormData());
    expect(result.success).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});
