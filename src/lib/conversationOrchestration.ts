import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequests,
  conversations,
  messages,
  organizations,
  services,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { isWithinBusinessHours, resolveScheduleConfig } from "@/lib/businessHours";
import {
  applyTransition,
  canTransition,
  checkCompletionGate,
} from "@/lib/collectionRequestStateMachine";
import { OperationFailedError } from "@/lib/resilience";
import { toE164 } from "@/lib/whatsapp/phone";
import { sendTemplateMessage, sendTextMessage, WhatsAppSendError } from "@/lib/whatsapp/send";
import {
  DUPLICATE_BODY as DUPLICATE_TEMPLATE,
  INITIAL_REQUEST_BODY as INITIAL_REQUEST_TEMPLATE,
  TEMPLATE_BY_BODY,
  THANK_YOU_BODY as THANK_YOU_TEMPLATE,
} from "@/lib/whatsapp/templates";

/**
 * Real WhatsApp Cloud API integration (Real WhatsApp Integration M-WA-3 —
 * see ARCHITECTURE.md's Document History). All the decision logic
 * (Ch.10 conversation flow, Ch.16 automation rules) is unchanged; only
 * sendOutboundMessage's transport is real now. Sending degrades
 * gracefully rather than crashing a Collection Request — an org that
 * isn't connected yet, an unnormalizable phone number, or a Cloud API
 * failure all still record the message (matching the mock's old
 * always-succeeds shape from the caller's perspective) with
 * messages.deliveryStatus capturing what actually happened, mirroring
 * driveAdapter.ts's uploadDocumentResiliently philosophy.
 */

async function getOrganizationConfig(organizationId: string) {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new Error("Organization not found");
  return organization;
}

// Epic 3: a Business Type's backing Service may override the org's default
// reminder/business-hours config — resolve the specific service a given
// conversation belongs to (via its Collection Request) so gating uses the
// effective config, not just the org-wide default.
async function getServiceForConversation(conversationId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ service: services })
    .from(conversations)
    .innerJoin(collectionRequests, eq(conversations.collectionRequestId, collectionRequests.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.service ?? null;
}

// BR-003: one conversation per active Collection Request.
export async function ensureConversation(
  organizationId: string,
  collectionRequestId: string,
  clientId: string
) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.collectionRequestId, collectionRequestId))
    .limit(1);
  if (existing) return existing;

  const [conversation] = await db
    .insert(conversations)
    .values({ organizationId, clientId, collectionRequestId })
    .returning();
  return conversation;
}

async function getClientPhoneForConversation(conversationId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ phone: clients.phone })
    .from(conversations)
    .innerJoin(clients, eq(conversations.clientId, clients.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.phone ?? null;
}

// The real Cloud API send — never throws; every failure mode (not
// connected, bad phone, no matching approved template, a genuine API
// failure) is caught and turned into a deliveryStatus string instead,
// per this module's doc comment. "ai" sends always go through a
// pre-approved Template (WhatsApp platform requirement); "employee"
// sends stay free-form text, since they only ever happen inside an
// already-open conversation with the client.
async function sendViaWhatsApp(
  organization: typeof organizations.$inferSelect,
  conversationId: string,
  body: string,
  senderType: "ai" | "employee"
): Promise<{ whatsappMessageId: string | null; deliveryStatus: string }> {
  if (!organization.whatsappPhoneNumberId) {
    return { whatsappMessageId: null, deliveryStatus: "not_connected" };
  }

  const rawPhone = await getClientPhoneForConversation(conversationId);
  const to = rawPhone ? toE164(rawPhone) : null;
  if (!to) {
    return { whatsappMessageId: null, deliveryStatus: "invalid_phone" };
  }

  try {
    if (senderType === "ai") {
      const template = TEMPLATE_BY_BODY.get(body);
      if (!template) {
        return { whatsappMessageId: null, deliveryStatus: "no_template" };
      }
      const result = await sendTemplateMessage(organization.whatsappPhoneNumberId, to, template.name, template.language);
      return { whatsappMessageId: result.messageId, deliveryStatus: "sent" };
    }

    const result = await sendTextMessage(organization.whatsappPhoneNumberId, to, body);
    return { whatsappMessageId: result.messageId, deliveryStatus: "sent" };
  } catch (error) {
    if (!(error instanceof WhatsAppSendError) && !(error instanceof OperationFailedError)) throw error;
    console.error("[whatsapp] send failed (non-fatal, message still recorded)", error);
    return { whatsappMessageId: null, deliveryStatus: "failed" };
  }
}

// BR-18.1 gating is real: outside business hours, automated ("ai")
// messages are held rather than sent — see the returned `sent` flag,
// surfaced by callers. `sent` reflects only that gate, exactly as
// before M-WA-3 — it is not the same thing as real delivery success,
// which is recorded separately on the message row's own deliveryStatus
// (see sendViaWhatsApp above) so a real send failure never changes this
// function's return shape or crashes a caller that only checks `sent`.
export async function sendOutboundMessage(
  organizationId: string,
  conversationId: string,
  body: string,
  senderType: "ai" | "employee"
): Promise<{ sent: boolean }> {
  const db = await getDb();
  const organization = await getOrganizationConfig(organizationId);

  if (senderType === "ai") {
    const service = await getServiceForConversation(conversationId);
    const effectiveConfig = resolveScheduleConfig(organization, service);
    if (!isWithinBusinessHours(effectiveConfig)) {
      return { sent: false };
    }
  }

  const { whatsappMessageId, deliveryStatus } = await sendViaWhatsApp(
    organization,
    conversationId,
    body,
    senderType
  );

  await db.insert(messages).values({
    organizationId,
    conversationId,
    direction: "outbound",
    senderType,
    body,
    whatsappMessageId,
    deliveryStatus,
  });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  return { sent: true };
}

export async function recordInboundMessage(
  organizationId: string,
  conversationId: string,
  body: string
) {
  const db = await getDb();
  await db.insert(messages).values({
    organizationId,
    conversationId,
    direction: "inbound",
    senderType: "client",
    body,
  });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// Ch.10 flow step 1: "Send one initial request."
//
// Product Evolution M7 — also returns whether the message actually sent
// (false when BR-18.1's business-hours gate held it). Existing callers
// (e.g. collections/conversationActions.ts's initiateConversation) that
// only awaited the old bare-conversation return value are unaffected —
// they simply don't read the new field. M7's own callers (Template "Send
// Now"/scheduled delivery) need it to know whether to mark the request
// delivered or leave it queued for a later retry.
export async function startConversation(
  organizationId: string,
  collectionRequestId: string,
  clientId: string
): Promise<{ conversation: Awaited<ReturnType<typeof ensureConversation>>; sent: boolean }> {
  const conversation = await ensureConversation(
    organizationId,
    collectionRequestId,
    clientId
  );
  const { sent } = await sendOutboundMessage(
    organizationId,
    conversation.id,
    INITIAL_REQUEST_TEMPLATE,
    "ai"
  );
  return { conversation, sent };
}

export async function sendDuplicateAcknowledgement(
  organizationId: string,
  conversationId: string
) {
  await sendOutboundMessage(
    organizationId,
    conversationId,
    DUPLICATE_TEMPLATE,
    "ai"
  );
}

// Ch.10 step 3-4: the stand-in for "after N minutes of inactivity" (no
// background scheduler exists yet, see M6) — an employee (or, later, a
// cron tick) calls this to ask "is everything satisfied?". Silent if not
// (step 2: "stay silent while documents are uploaded").
export async function evaluateAndPrompt(
  organizationId: string,
  collectionRequestId: string,
  conversationId: string
): Promise<{ prompted: boolean; reason: string | null }> {
  const gateError = await checkCompletionGate(collectionRequestId);
  if (gateError) return { prompted: false, reason: gateError };

  const db = await getDb();
  const { sent } = await sendOutboundMessage(
    organizationId,
    conversationId,
    THANK_YOU_TEMPLATE,
    "ai"
  );
  if (!sent) {
    return { prompted: false, reason: "מחוץ לשעות הפעילות המוגדרות." };
  }

  await db
    .update(conversations)
    .set({ status: "waiting_for_client" })
    .where(eq(conversations.id, conversationId));

  // Keep the Collection Request's own status (also part of the Ch.6
  // state machine) in sync with the conversation, so the scheduler and
  // dashboard can query one source of truth instead of joining both.
  const [current] = await db
    .select({ status: collectionRequests.status })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (current && canTransition(current.status, "waiting_for_client")) {
    await applyTransition(
      organizationId,
      undefined,
      "ai",
      collectionRequestId,
      "waiting_for_client"
    );
  }

  return { prompted: true, reason: null };
}

// If new documents arrive after a Collection Request was already
// completed, Centro reopens it automatically (Ch.10 step 7 / Ch.16
// FR-16.8 / glossary "Reopened Collection").
export async function reopenIfCompleted(
  organizationId: string,
  collectionRequestId: string
) {
  const db = await getDb();
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!current || current.status !== "completed") return false;

  await db
    .update(collectionRequests)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(collectionRequests.id, collectionRequestId));

  await recordAuditEvent({
    organizationId,
    eventType: "collection_request.reopened",
    description: "בקשת האיסוף נפתחה מחדש עקב מסמך חדש שהתקבל",
    actorType: "system",
    clientId: current.clientId,
    collectionRequestId,
    metadata: { from: "completed", to: "active" },
  });

  return true;
}

export async function getConversationByCollectionRequest(
  collectionRequestId: string
) {
  const db = await getDb();
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.collectionRequestId, collectionRequestId))
    .limit(1);
  return conversation ?? null;
}

export async function listMessages(conversationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}
