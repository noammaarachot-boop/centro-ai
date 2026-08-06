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
import { evaluateAutomationGate } from "@/lib/documentCollectionGate";
import {
  applyTransition,
  canTransition,
  checkCompletionGate,
} from "@/lib/collectionRequestStateMachine";
import { OperationFailedError } from "@/lib/resilience";
import { getRequestRequirementNames } from "@/lib/documentRequestList";
import { toE164 } from "@/lib/whatsapp/phone";
import { buildInitialRequestSend } from "@/lib/whatsapp/initialRequestMessage";
import { sendTemplateMessage, sendTextMessage, WhatsAppSendError } from "@/lib/whatsapp/send";
import { TEMPLATE_BY_BODY, THANK_YOU_BODY as THANK_YOU_TEMPLATE } from "@/lib/whatsapp/templates";

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
// An explicit, pre-resolved parameterized template send — used for the
// dynamic initial document request (see buildInitialRequestSend). When
// provided, it overrides the exact-body TEMPLATE_BY_BODY lookup, so a
// rendered body that isn't itself a template key (e.g. the v2 body with the
// document list substituted in) is still sent through the right template.
interface TemplateSend {
  templateName: string;
  language: string;
  params: string[];
}

async function sendViaWhatsApp(
  organization: typeof organizations.$inferSelect,
  conversationId: string,
  body: string,
  senderType: "ai" | "employee",
  templateSend?: TemplateSend,
  // An "ai" send with no matching pre-approved template normally fails
  // with no_template (WhatsApp requires a template for business-initiated
  // messages). Set this when the send is a *direct reaction* to a message
  // the client just sent (a confirmation/clarification question, or an
  // acknowledgment of the client's own reply) — WhatsApp's 24-hour
  // customer service session window allows free-form text there, the same
  // legal basis "employee" sends already rely on. Never set for a
  // send that could go out days after the client's last message (a
  // reminder) — the window may well have closed by then; see
  // documentIntakeReview.ts's own comment on that tradeoff.
  allowFreeform = false
): Promise<{ whatsappMessageId: string | null; deliveryStatus: string }> {
  // [wa-diag] TEMPORARY — no logic changed, recipient number not logged (PII).
  console.log("[wa-diag] sendViaWhatsApp ENTER", {
    senderType,
    phoneNumberId: organization.whatsappPhoneNumberId ?? null,
  });
  if (!organization.whatsappPhoneNumberId) {
    console.log("[wa-diag] BLOCKED (Level B): condition=not_connected (no whatsappPhoneNumberId) → NO Meta call");
    return { whatsappMessageId: null, deliveryStatus: "not_connected" };
  }

  const rawPhone = await getClientPhoneForConversation(conversationId);
  const to = rawPhone ? toE164(rawPhone) : null;
  if (!to) {
    console.log("[wa-diag] BLOCKED (Level B): condition=invalid_phone (client phone not valid E.164) → NO Meta call", {
      rawPhonePresent: !!rawPhone,
    });
    return { whatsappMessageId: null, deliveryStatus: "invalid_phone" };
  }

  try {
    if (senderType === "ai" && !(allowFreeform && !templateSend)) {
      // Prefer an explicit template descriptor (dynamic initial request);
      // otherwise resolve the static template by its exact body text.
      let templateName: string;
      let language: string;
      let params: string[];
      if (templateSend) {
        templateName = templateSend.templateName;
        language = templateSend.language;
        params = templateSend.params;
      } else {
        const template = TEMPLATE_BY_BODY.get(body);
        if (!template) {
          console.log("[wa-diag] BLOCKED (Level B): condition=no_template (body not mapped to an approved template) → NO Meta call");
          return { whatsappMessageId: null, deliveryStatus: "no_template" };
        }
        templateName = template.name;
        language = template.language;
        params = [];
      }
      console.log("[wa-diag] REACHED Meta call (template)", {
        phoneNumberId: organization.whatsappPhoneNumberId,
        templateName,
        language,
        paramCount: params.length,
      });
      const result = await sendTemplateMessage(organization.whatsappPhoneNumberId, to, templateName, language, params);
      console.log("[wa-diag] template send returned OK", { messageId: result.messageId });
      return { whatsappMessageId: result.messageId, deliveryStatus: "sent" };
    }

    if (senderType === "ai") {
      console.log("[wa-diag] REACHED Meta call (ai free-form, 24h session window)", {
        phoneNumberId: organization.whatsappPhoneNumberId,
      });
    }
    console.log("[wa-diag] REACHED Meta call (text)", { phoneNumberId: organization.whatsappPhoneNumberId });
    const result = await sendTextMessage(organization.whatsappPhoneNumberId, to, body);
    console.log("[wa-diag] text send returned OK", { messageId: result.messageId });
    return { whatsappMessageId: result.messageId, deliveryStatus: "sent" };
  } catch (error) {
    if (!(error instanceof WhatsAppSendError) && !(error instanceof OperationFailedError)) throw error;
    console.error("[whatsapp] send failed (non-fatal, message still recorded)", error);
    // Owner Dashboard System Health signal. Best-effort and isolated from
    // the non-fatal contract above: a failure recording the failure must
    // never turn this into a thrown error.
    try {
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "whatsapp.outbound_send_failed",
        description: "שליחת הודעת WhatsApp יוצאת נכשלה",
        actorType: "system",
        metadata: { severity: "warning" },
      });
    } catch (auditError) {
      console.error("[owner-health] failed to record whatsapp.outbound_send_failed audit event", auditError);
    }
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
//
// Product Evolution M9 ("Disable automation must really disable
// automation") — the same non-throwing "held, not sent" pattern now also
// covers the organization's automationActivatedAt (the "Deactivate
// automation" toggle in Settings) and, when this conversation's Collection
// Request belongs to one, that Service's own automationPausedAt (the
// per-template pause). Both gates apply only to "ai" (automated) sends —
// an employee's own free-text message inside an already-open conversation
// is a deliberate human action, never "automation," and is never held by
// either gate.
export async function sendOutboundMessage(
  organizationId: string,
  conversationId: string,
  body: string,
  senderType: "ai" | "employee",
  // "manual"  — a human explicitly triggered this from Centro (Send Now,
  //             Initiate, an employee reply). ALWAYS allowed: never gated
  //             by documentCollectionEnabled, automationPausedAt, or
  //             business hours.
  // "automated" (default) — an autonomous action (scheduler/cron, follow-up
  //             prompt, reminder, auto-confirmation). Runs only while the
  //             org's documentCollectionEnabled gate (and the narrower
  //             per-service pause / business-hours gates) allow it.
  // senderType is an orthogonal WhatsApp-transport concern (template vs
  //             free text), deliberately separate from this trigger.
  trigger: "manual" | "automated" = "automated",
  // Optional explicit template descriptor (dynamic initial request). When
  // omitted, an "ai" send resolves its template from `body` as before.
  templateSend?: TemplateSend,
  // See sendViaWhatsApp's own doc comment: set only for an "ai" send that is
  // a direct reaction to a message the client just sent, within the 24h
  // WhatsApp session window, with no pre-approved template for its dynamic
  // text (e.g. a document-intake confirmation/clarification question).
  allowFreeform = false
): Promise<{ sent: boolean }> {
  const db = await getDb();
  const organization = await getOrganizationConfig(organizationId);

  console.log("[document-collection] document_collection_send_started", {
    organizationId,
    conversationId,
    senderType,
    trigger,
  });

  // [wa-diag] TEMPORARY diagnostic logging — kept only until one more live
  // end-to-end test confirms the new flow; removed in Phase 3.
  console.log("[wa-diag] sendOutboundMessage ENTER", {
    organizationId,
    conversationId,
    senderType,
    trigger,
    phoneNumberIdPresent: !!organization.whatsappPhoneNumberId,
  });

  // Automation gates apply ONLY to autonomous template sends. A manual
  // (human-initiated) send, and any employee free-text send, bypass every
  // gate here and always proceed. The rule itself lives in the pure,
  // unit-tested evaluateAutomationGate.
  if (senderType === "ai" && trigger === "automated") {
    const service = await getServiceForConversation(conversationId);
    const effectiveConfig = resolveScheduleConfig(organization, service);
    const decision = evaluateAutomationGate({
      senderType,
      trigger,
      documentCollectionEnabled: organization.documentCollectionEnabled,
      automationPaused: !!service?.automationPausedAt,
      withinBusinessHours: isWithinBusinessHours(effectiveConfig),
    });
    if (!decision.allowed) {
      console.log("[document-collection] document_collection_send_blocked", {
        organizationId,
        conversationId,
        reason: decision.reason,
      });
      console.log("[wa-diag] BLOCKED (automated gate):", decision.reason, "→ sent:false, NO Meta call");
      return { sent: false };
    }
    console.log("[wa-diag] automated gates PASSED → calling sendViaWhatsApp");
  }

  const { whatsappMessageId, deliveryStatus } = await sendViaWhatsApp(
    organization,
    conversationId,
    body,
    senderType,
    templateSend,
    allowFreeform
  );

  if (deliveryStatus === "sent") {
    console.log("[document-collection] document_collection_send_accepted", {
      organizationId,
      conversationId,
      whatsappMessageId,
    });
  } else {
    console.log("[document-collection] document_collection_send_failed", {
      organizationId,
      conversationId,
      deliveryStatus,
    });
  }

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
  clientId: string,
  // Forwarded to sendOutboundMessage: "manual" for a human-initiated send
  // (Send Now / Initiate), "automated" for scheduler/cron. Defaults to
  // "automated" so the autonomous schedulers keep their gated behavior
  // without any change.
  trigger: "manual" | "automated" = "automated"
): Promise<{ conversation: Awaited<ReturnType<typeof ensureConversation>>; sent: boolean }> {
  const conversation = await ensureConversation(
    organizationId,
    collectionRequestId,
    clientId
  );
  // Build the initial request from THIS request's own frozen requirement
  // snapshot (collectionRequestRequirements) — never a hardcoded list. While
  // v2 is not yet enabled, this resolves to the static v1 template with no
  // params (identical to prior behavior); once approved+enabled it becomes
  // the v2 template carrying the dynamic document list.
  const requirementNames = await getRequestRequirementNames(organizationId, collectionRequestId);
  const initial = buildInitialRequestSend(requirementNames);
  const { sent } = await sendOutboundMessage(
    organizationId,
    conversation.id,
    initial.renderedBody,
    "ai",
    trigger,
    { templateName: initial.templateName, language: initial.language, params: initial.params }
  );
  return { conversation, sent };
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
