import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { CONFIRM_NO_BUTTON_ID, CONFIRM_YES_BUTTON_ID } from "@/lib/pendingConfirmations";

// Phase 4 (conversation-intelligence redesign cutover) — sharedDb backs
// handleInboundMessage's own getDb() calls for the routing-boundary test
// below. The pre-existing isUniqueViolation tests below construct their
// own local PGlite instance directly and never call getDb() at all, so
// this mock does not affect them.
let sharedDb: Database;
vi.mock("@/db", () => ({
  getDb: async () => sharedDb,
}));

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendInteractiveButtonsMessage: vi.fn().mockResolvedValue({ messageId: "wamid.out" }),
    sendTemplateMessage: vi.fn(),
  };
});

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  generateText: vi.fn().mockResolvedValue({ text: "תשובה" }),
}));

const { isUniqueViolation, resolveInteractiveReplyText, handleInboundMessage } = await import("./route");

// WhatsApp Interactive Reply Buttons — mandatory scenario "הלקוח לוחץ על
// כפתור". A button tap arrives with no message.text at all; this proves
// the normalization into plain "כן"/"לא" text (which every existing
// resolver already understands) is correct, without needing a full
// signed-webhook-POST integration harness.
describe("resolveInteractiveReplyText", () => {
  it("normalizes the confirm-yes button id to \"כן\"", () => {
    const message = {
      from: "972500000000",
      id: "wamid.1",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: CONFIRM_YES_BUTTON_ID, title: "כן" } },
    };
    expect(resolveInteractiveReplyText(message)).toBe("כן");
  });

  it("normalizes the confirm-no button id to \"לא\"", () => {
    const message = {
      from: "972500000000",
      id: "wamid.2",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: CONFIRM_NO_BUTTON_ID, title: "לא" } },
    };
    expect(resolveInteractiveReplyText(message)).toBe("לא");
  });

  it("returns null for a plain text message (no interactive payload)", () => {
    const message = { from: "972500000000", id: "wamid.3", type: "text", text: { body: "כן" } };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });

  it("never guesses an unrecognized button id", () => {
    const message = {
      from: "972500000000",
      id: "wamid.4",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "some_other_id", title: "?" } },
    };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });

  it("returns null for a non-button interactive type (e.g. a list reply)", () => {
    const message = { from: "972500000000", id: "wamid.5", type: "interactive", interactive: { type: "list_reply" } };
    expect(resolveInteractiveReplyText(message)).toBeNull();
  });
});

// isUniqueViolation is the backstop behind the webhook's fast-path
// idempotency check (see handleInboundMessage) — it decides whether a
// thrown DB error is the *expected* outcome of two redelivered webhooks
// racing to insert the same WhatsApp message, or a genuinely unexpected
// failure that should be logged and surfaced. Getting the error shape
// wrong (assuming a `.code`/`.constraint_name` shape postgres-js doesn't
// actually produce) would either swallow real bugs or spam false alarms
// for every duplicate webhook delivery — worth proving against a real
// Postgres engine (PGlite), not just a guessed error shape.
describe("isUniqueViolation", () => {
  it("recognizes a real unique-constraint violation on documents.whatsapp_message_id", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db as never, { migrationsFolder: "./drizzle" });

    const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
    const [clientRow] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "Client", phone: "+972500000000" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p" })
      .returning();

    await db.insert(schema.documents).values({
      organizationId: org.id,
      collectionRequestId: request.id,
      fileName: "a.jpg",
      whatsappMessageId: "wamid.same",
    });

    let caught: unknown = null;
    try {
      await db.insert(schema.documents).values({
        organizationId: org.id,
        collectionRequestId: request.id,
        fileName: "b.jpg",
        whatsappMessageId: "wamid.same",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught, "documents_whatsapp_message_id_idx")).toBe(true);
  }, 30_000);

  it("does not match a differently-named constraint (never swallows an unrelated unique violation)", () => {
    const fakeError = { code: "23505", constraint_name: "some_other_constraint" };
    expect(isUniqueViolation(fakeError, "documents_whatsapp_message_id_idx")).toBe(false);
  });

  it("does not match a non-unique-violation error", () => {
    const fakeError = { code: "23503", constraint_name: "documents_whatsapp_message_id_idx" };
    expect(isUniqueViolation(fakeError, "documents_whatsapp_message_id_idx")).toBe(false);
  });

  it("handles non-object errors safely", () => {
    expect(isUniqueViolation("plain string error", "documents_whatsapp_message_id_idx")).toBe(false);
    expect(isUniqueViolation(null, "documents_whatsapp_message_id_idx")).toBe(false);
    expect(isUniqueViolation(undefined, "documents_whatsapp_message_id_idx")).toBe(false);
  });
});

// Phase 4 — the real production routing-boundary proof. handleInboundMessage
// is the exact function processClaimedMessages (this same file's POST
// handler) calls for every real WhatsApp message — not a paraphrase, not
// understandConversationTurn tested in isolation. This proves the actual
// production entry point now reaches the new conversation-intelligence
// pipeline and never the legacy classifier, without needing a deployed
// webhook or a live Meta call.
describe("handleInboundMessage — Phase 4 cutover: the real entry point routes through understandConversationTurn, never legacy", () => {
  beforeAll(async () => {
    const client = new PGlite();
    sharedDb = drizzle(client, { schema }) as unknown as Database;
    await migrate(sharedDb as never, { migrationsFolder: "./drizzle" });
  }, 60_000);

  beforeEach(() => {
    sendTextMessage.mockReset();
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    resolveLanguageModel.mockReset();
    resolveLanguageModel.mockResolvedValue({});
    generateObject.mockReset();
  });

  async function seedOpenConversation() {
    const [org] = await sharedDb
      .insert(schema.organizations)
      .values({ name: "Org", googleDriveFolderId: "root-1", documentCollectionEnabled: true, whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
      .returning();
    const [clientRow] = await sharedDb
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
      .returning();
    const [service] = await sharedDb.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
    const [request] = await sharedDb
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p1" })
      .returning();
    await sharedDb
      .insert(schema.conversations)
      .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id, status: "open" });
    return { org, requestId: request.id };
  }

  it("a real inbound text message reaches the NEW pipeline's audit trail, never the legacy classifier's", async () => {
    const { org, requestId } = await seedOpenConversation();

    generateObject.mockResolvedValueOnce({ object: { status: "no_reference" } }); // resolveConversationReference
    // reasonAboutMessage's real schema is a discriminated union — only the
    // fields the UNRELATED branch actually declares.
    generateObject.mockResolvedValueOnce({ object: { outcome: "UNRELATED", confidence: 0.9 } });

    await handleInboundMessage(org, {
      from: "972500000000",
      id: `wamid.route-test-${crypto.randomUUID()}`,
      type: "text",
      text: { body: "הודעה כלשהי" },
    } as never);

    const audits = await sharedDb.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    const newPipelineEvents = audits.filter((a) => a.eventType === "message.conversation_reasoning_outcome");
    const legacyEvents = audits.filter((a) => a.eventType === "message.conversation_intent_classified" || a.eventType === "message.intent_classified");

    expect(newPipelineEvents).toHaveLength(1); // the new pipeline genuinely ran
    expect(legacyEvents).toEqual([]); // the legacy classifier never ran for this turn
  });
});

// Completion-is-terminal invariant (root-cause fix) — a real production
// case showed a client still getting automated replies (including an
// automatic "reopen?" question) well after being told their request was
// done. Once collectionRequests.status is "completed" (which always closes
// its conversation — see collectionRequestStateMachine.ts's applyTransition),
// the webhook must never engage with that conversation again: no reply, no
// AI call, no document processing, no reopening, no new review item — the
// inbound message is still recorded as plain history, and nothing else.
describe("handleInboundMessage — a completed request's conversation never receives automated engagement again", () => {
  beforeAll(async () => {
    const client = new PGlite();
    sharedDb = drizzle(client, { schema }) as unknown as Database;
    await migrate(sharedDb as never, { migrationsFolder: "./drizzle" });
  }, 60_000);

  beforeEach(() => {
    sendTextMessage.mockReset();
    resolveLanguageModel.mockReset();
    generateObject.mockReset();
  });

  async function seedCompletedRequest() {
    const [org] = await sharedDb
      .insert(schema.organizations)
      .values({ name: "Org", googleDriveFolderId: "root-1", documentCollectionEnabled: true, whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
      .returning();
    const [clientRow] = await sharedDb
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
      .returning();
    const [service] = await sharedDb.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
    const [request] = await sharedDb
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p1", status: "completed", completedAt: new Date() })
      .returning();
    const [conversation] = await sharedDb
      .insert(schema.conversations)
      .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id, status: "closed" })
      .returning();
    return { org, requestId: request.id, conversationId: conversation.id };
  }

  it("an incoming text message gets no automated reply, no AI reasoning call, and no reopening", async () => {
    const { org, requestId, conversationId } = await seedCompletedRequest();

    await handleInboundMessage(org, {
      from: "972500000000",
      id: `wamid.post-completion-text-${crypto.randomUUID()}`,
      type: "text",
      text: { body: "יש לי עוד שאלה" },
    } as never);

    // Recorded as plain communication history — this is the ONE thing
    // that's still allowed.
    const messages = await sharedDb.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("inbound");

    // Nothing else: no outbound reply, no AI call, request still completed,
    // conversation still closed.
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
    const [request] = await sharedDb.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await sharedDb.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
  });

  it("an incoming attachment is never processed, uploaded, or matched — no document row is created and the request is not reopened", async () => {
    const { org, requestId, conversationId } = await seedCompletedRequest();

    await handleInboundMessage(org, {
      from: "972500000000",
      id: `wamid.post-completion-attachment-${crypto.randomUUID()}`,
      type: "image",
      image: { id: "media-1", mime_type: "image/jpeg" },
    } as never);

    const documents = await sharedDb.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(documents).toHaveLength(0);

    const [request] = await sharedDb.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed"); // never auto-reopened to "active"

    const messages = await sharedDb.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1); // still recorded as plain history
    expect(messages[0].direction).toBe("inbound");
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("never creates a new employeeReviewItem or pending confirmation for a completed request", async () => {
    const { org, requestId } = await seedCompletedRequest();

    await handleInboundMessage(org, {
      from: "972500000000",
      id: `wamid.post-completion-question-${crypto.randomUUID()}`,
      type: "text",
      text: { body: "אני צריך שתחזרו אליי בהקדם" },
    } as never);

    const reviewItems = await sharedDb
      .select()
      .from(schema.employeeReviewItems)
      .where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toHaveLength(0);

    const confirmations = await sharedDb
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmations).toHaveLength(0);
  });
});
