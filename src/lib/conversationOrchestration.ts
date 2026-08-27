import { desc, eq, and, isNull } from "drizzle-orm";
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
import { captureError } from "@/lib/monitoring/errorReporting";
import { getRequestRequirementNames } from "@/lib/documentRequestList";
import { toE164 } from "@/lib/whatsapp/phone";
import { formatRequirementListForTemplateParam } from "@/lib/documentRequestList";
import {
  buildTemplateParams,
  renderTemplateBody,
  resolveApprovedTemplate,
  resolveOrganizationWhatsAppConfig,
} from "@/lib/whatsapp/organizationWhatsApp";
import {
  type InteractiveButton,
  type TemplateBodyParam,
  sendInteractiveButtonsMessage,
  sendTemplateMessage,
  sendTextMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp/send";
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
// Reminder-lifecycle root-cause fix (2026-08-16) — reviewDeadlineAt used to
// be set only on entry into waiting_for_client (the "client says done,
// employee has 3 days to double-check" window) or on an explicit deferral
// resolving. A request the client never responds to at all — never reaches
// waiting_for_client, never triggers a deferral — had no 3-day clock at
// all, so it could sit "active" forever with no escalation path. Set here,
// once, at the single moment a conversation is first created for a request
// (the real "request sent" instant, matching reminderAnchorAt's own
// semantics) — guarded by IS NULL so a later, legitimate reset (waiting_for_
// client entry, deferral resolution, explicit resend) is never overwritten.
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
  await db
    .update(collectionRequests)
    .set({ reviewDeadlineAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) })
    .where(and(eq(collectionRequests.id, collectionRequestId), isNull(collectionRequests.reviewDeadlineAt)));
  return conversation;
}

// Observability remediation — sendOutboundMessage resolves this once for
// every call so its own centralized recordAuditEvent (every exit path)
// always carries the collectionRequestId, without every caller having to
// supply one it may not have on hand (e.g. a caller that only has a
// conversationId).
async function getCollectionRequestIdForConversation(conversationId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ collectionRequestId: conversations.collectionRequestId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.collectionRequestId ?? null;
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
export interface TemplateSend {
  templateName: string;
  language: string;
  params: TemplateBodyParam[];
}


/**
 * A send is only 'sent' if the provider handed back a message id.
 *
 * A 2xx with no id in the body is not an acceptance we can prove, and
 * without an id there is no handle to reconcile the message against later —
 * no delivery webhook can ever match it. Recording it as sent would be the
 * same unprovable claim this whole area exists to remove, just one layer
 * lower down.
 */
function acceptedOrFailed(
  result: { messageId?: string | null } | null | undefined
): { whatsappMessageId: string | null; deliveryStatus: string; failureReason?: string } {
  const messageId = result?.messageId ?? null;
  if (!messageId) {
    return {
      whatsappMessageId: null,
      deliveryStatus: "failed",
      failureReason: "provider returned no message id",
    };
  }
  return { whatsappMessageId: messageId, deliveryStatus: "sent" };
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
  allowFreeform = false,
  // WhatsApp Interactive Reply Buttons — real tappable buttons instead of
  // "1️⃣ כן / 2️⃣ לא" typed-number text. Only takes effect on the same
  // free-form path allowFreeform already gates (a Template can't carry
  // buttons here, and a reminder days later risks the closed session
  // window the same way free text does) — see sendInteractiveButtonsMessage's
  // own doc comment for the 3-button Meta cap that's why this is only used
  // for a single yes/no question, never a combined multi-group one.
  interactiveButtons?: InteractiveButton[]
): Promise<{ whatsappMessageId: string | null; deliveryStatus: string; failureReason?: string }> {
  // [wa-diag] TEMPORARY — no logic changed, recipient number not logged (PII).
  console.log("[wa-diag] sendViaWhatsApp ENTER", {
    senderType,
    phoneNumberId: organization.whatsappPhoneNumberId ?? null,
  });
  if (!organization.whatsappPhoneNumberId) {
    console.log("[wa-diag] BLOCKED (Level B): condition=not_connected (no whatsappPhoneNumberId) → NO Meta call");
    return { whatsappMessageId: null, deliveryStatus: "not_connected" };
  }

  // Manual per-organization WhatsApp connection — an organization with its
  // own Access Token (organizations.whatsappAccessTokenEnc, set only via
  // the owner-only manual connect flow, /owner/organizations/[id]) sends
  // through that instead of the shared WHATSAPP_SYSTEM_USER_TOKEN. Every
  // organization connected the existing Embedded Signup way has this
  // column null and is completely unaffected — undefined here means
  // send.ts's own postMessage falls back to the shared token exactly as
  // before this feature existed.
  // This organization's own credentials, resolved together.
  // `undefined` when absent, which let send.ts fall back to the shared
  // WHATSAPP_SYSTEM_USER_TOKEN — Centro's own account — so an office with a
  // broken connection would send from the wrong WhatsApp number instead of
  // reporting that its connection is broken.
  // One resolver decides the credential AND which account it belongs to, so
  // the phone number id and the token can never come from different
  // organizations. It returns the office's own token for a manual connection
  // and Centro's Tech Provider token for an Embedded Signup one — both are
  // authorised for THIS organization's WABA, and neither is another tenant's.
  const resolvedConfig = await resolveOrganizationWhatsAppConfig(organization.id);
  if (!resolvedConfig.ok) {
    console.log("[wa-diag] BLOCKED: organization WhatsApp configuration incomplete → NO Meta call", {
      problem: resolvedConfig.problem,
    });
    return {
      whatsappMessageId: null,
      deliveryStatus: "not_connected",
      failureReason: resolvedConfig.reason,
    };
  }
  const accessToken = resolvedConfig.config.accessToken;

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
      let params: TemplateBodyParam[];
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
      const result = await sendTemplateMessage(organization.whatsappPhoneNumberId, to, templateName, language, params, accessToken);
      console.log("[wa-diag] template send returned OK", { messageId: result.messageId });
      return acceptedOrFailed(result);
    }

    if (senderType === "ai") {
      console.log("[wa-diag] REACHED Meta call (ai free-form, 24h session window)", {
        phoneNumberId: organization.whatsappPhoneNumberId,
      });
    }
    if (interactiveButtons && interactiveButtons.length > 0) {
      console.log("[wa-diag] REACHED Meta call (interactive buttons)", {
        phoneNumberId: organization.whatsappPhoneNumberId,
        buttonCount: interactiveButtons.length,
      });
      const result = await sendInteractiveButtonsMessage(organization.whatsappPhoneNumberId, to, body, interactiveButtons, accessToken);
      console.log("[wa-diag] interactive buttons send returned OK", { messageId: result.messageId });
      return acceptedOrFailed(result);
    }
    console.log("[wa-diag] REACHED Meta call (text)", { phoneNumberId: organization.whatsappPhoneNumberId });
    const result = await sendTextMessage(organization.whatsappPhoneNumberId, to, body, accessToken);
    console.log("[wa-diag] text send returned OK", { messageId: result.messageId });
    return acceptedOrFailed(result);
  } catch (error) {
    // EVERY failure is recorded, not just the two we named.
    //
    // This used to rethrow anything that wasn't a WhatsAppSendError or an
    // OperationFailedError — which is exactly the set you cannot enumerate
    // in advance: a socket timeout, a DNS failure, a malformed or truncated
    // response that blows up on parse. Those escaped, so the finalizing
    // UPDATE below never ran and the row stayed "pending" forever with no
    // record of why, while the throw propagated out of sendOutboundMessage
    // and could abort the rest of the scheduler tick — every other
    // organization's work included.
    //
    // This function's documented contract is "never throws, always
    // records". It now actually keeps it. An unexpected error is still
    // reported to monitoring, so a genuine bug is loud rather than
    // swallowed; it just no longer takes the tick down with it.
    const expected = error instanceof WhatsAppSendError || error instanceof OperationFailedError;
    if (!expected) {
      captureError(error, { scope: "whatsapp.send", organizationId: organization.id, conversationId });
    }
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
        // The provider's own reason, not just "warning". 730 failed sends
        // in production carried metadata {"severity":"warning"} and nothing
        // else, so there was no way to answer "why did WhatsApp reject
        // this?" from the data — the single most useful fact about a
        // failure was the one thing being thrown away. Recorded here only;
        // never surfaced to the office user, who sees a plain "לא נשלחה".
        metadata: {
          severity: "warning",
          failureReason: describeSendFailure(error),
          errorName: (error as Error).name,
        },
      });
    } catch (auditError) {
      console.error("[owner-health] failed to record whatsapp.outbound_send_failed audit event", auditError);
    }
    return { whatsappMessageId: null, deliveryStatus: "failed", failureReason: describeSendFailure(error) };
  }
}

/**
 * A short, non-sensitive description of why the provider refused a send.
 *
 * Deliberately bounded: enough to debug a class of failure (auth, template,
 * window, rate limit) without copying an arbitrary provider payload — which
 * can carry the recipient's phone number — into audit_logs.
 */
function describeSendFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\+?\d[\d\s\-()]{7,}\d/g, "[phone]").slice(0, 300);
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
  allowFreeform = false,
  // WhatsApp Interactive Reply Buttons — see sendViaWhatsApp's own doc
  // comment.
  interactiveButtons?: InteractiveButton[],
  // A stable identity for the LOGICAL message. Supplied by autonomous
  // senders (reminders, scheduled deliveries) so that a repeated
  // invocation is suppressed by the database rather than trusted not to
  // happen. Omitted for deliberate human sends, which have no such
  // identity — two messages an employee actually typed are two messages.
  idempotencyKey?: string
  // deliveryStatus is additive (Phase 2.1 remediation) — existing callers
  // that only destructure `{ sent }` are unaffected. startConversation
  // uses it to detect a v2-template rejection and fall back to v1 without
  // needing sendOutboundMessage itself to ever throw (its own "never
  // throws, always records" contract stays intact for every other
  // caller).
): Promise<{ sent: boolean; deliveryStatus?: string; failureReason?: string }> {
  const db = await getDb();
  const organization = await getOrganizationConfig(organizationId);
  // Observability remediation — resolved once, up front, so it's available
  // to recordAuditEvent on every exit path below (blocked, sent, failed),
  // not just the ones a specific caller happened to already track.
  const collectionRequestId = await getCollectionRequestIdForConversation(conversationId);

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
      await recordAuditEvent({
        organizationId,
        eventType: "whatsapp.send_blocked",
        description: `שליחת הודעה אוטומטית נחסמה: ${decision.reason}`,
        actorType: "system",
        collectionRequestId: collectionRequestId ?? undefined,
        metadata: { conversationId, trigger, senderType, reason: decision.reason },
      });
      return { sent: false };
    }
    console.log("[wa-diag] automated gates PASSED → calling sendViaWhatsApp");
  }

  // Phase 3.1 remediation — the message row (and the conversation's own
  // updatedAt bump) is now written BEFORE the Meta call, not after. Under
  // the old order, a function killed between a successful Meta accept and
  // the DB write left zero record that a send ever happened: the next
  // scheduler tick still saw a stale conversation and sent the exact same
  // message again (a real duplicate client-facing message), because
  // nothing had bumped updatedAt or recorded the attempt. Writing "pending"
  // first means even a crash right after Meta accepts still leaves (a) an
  // audit trail that a send was attempted, and (b) updatedAt already
  // bumped, so the staleness-based reminder/nudge logic never re-fires on
  // the same conversation just because the final status update never
  // landed.
  // THE CLAIM. When the caller supplied an idempotency key, this insert is
  // what makes a duplicate send impossible: the unique index means only one
  // of any number of concurrent ticks, workers, retries or double-clicks
  // can create the row, and only the winner goes on to call the provider.
  // onConflictDoNothing turns the loser's insert into zero rows rather than
  // an exception, so it simply stops — before any Meta call, not after.
  const inserted = await db
    .insert(messages)
    .values({
      organizationId,
      conversationId,
      direction: "outbound",
      senderType,
      body,
      whatsappMessageId: null,
      deliveryStatus: "pending",
      idempotencyKey: idempotencyKey ?? null,
    })
    .onConflictDoNothing({ target: messages.idempotencyKey })
    .returning({ id: messages.id });

  if (inserted.length === 0) {
    // Someone else already owns this logical message. Not an error, and
    // emphatically not a second send.
    console.log("[document-collection] duplicate_send_suppressed", { organizationId, conversationId, idempotencyKey });
    return { sent: false, deliveryStatus: "duplicate_suppressed" };
  }
  const [pendingRow] = inserted;
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  const { whatsappMessageId, deliveryStatus, failureReason } = await sendViaWhatsApp(
    organization,
    conversationId,
    body,
    senderType,
    templateSend,
    allowFreeform,
    interactiveButtons
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

  // conversations.updatedAt was already bumped above, before the Meta call
  // — that's the write that actually matters for crash-safety, so it's not
  // repeated here (a second identical bump would be redundant, not more
  // correct).
  await db.update(messages).set({ whatsappMessageId, deliveryStatus }).where(eq(messages.id, pendingRow.id));

  // `sent` means the PROVIDER ACCEPTED IT — nothing weaker.
  //
  // It used to mean only "the automation gate didn't block me", so every
  // caller that asked "did this go out?" got true for a message Meta had
  // just rejected. attemptScheduledDelivery then flipped the request to
  // `active` and wrote the audit line "בקשת האיסוף נשלחה ללקוח" for a
  // client who received nothing — reproduced in production on a real
  // request whose 114 message rows are all deliveryStatus "failed" with no
  // WhatsApp id. Every screen downstream inherited that false success.
  //
  // The gate-blocked path above still returns sent:false separately, so
  // callers can keep telling "held by a gate" apart from "the provider
  // refused" via deliveryStatus.
  const accepted = deliveryStatus === "sent";

  // Observability remediation — unconditional, covers every deliveryStatus
  // outcome (sent/failed/not_connected/no_template/invalid_phone), so a
  // message that left this function always has a paired audit_logs row
  // provable back to its collectionRequestId, not just the sends whose
  // specific caller happened to also log its own event.
  await recordAuditEvent({
    organizationId,
    eventType: deliveryStatus === "sent" ? "whatsapp.send_completed" : "whatsapp.send_failed",
    description:
      deliveryStatus === "sent"
        ? "הודעת WhatsApp נשלחה בהצלחה"
        : `שליחת הודעת WhatsApp לא הושלמה: ${deliveryStatus}`,
    actorType: "system",
    collectionRequestId: collectionRequestId ?? undefined,
    metadata: { messageId: pendingRow.id, conversationId, trigger, senderType, deliveryStatus, whatsappMessageId, failureReason },
  });

  return { sent: accepted, deliveryStatus, failureReason };
}

export async function recordInboundMessage(
  organizationId: string,
  conversationId: string,
  body: string,
  // The inbound WhatsApp media/message id (Meta's wamid) when this message
  // came with one — set for a real attachment so the conversation thread's
  // display-time upgrade (resolveMessageDisplayBody, joined against
  // documents.whatsappMessageId) can later find the matching document and
  // resolve its human label. Omitted for plain text turns and the DevTools
  // simulator, which have no real wamid.
  whatsappMessageId?: string
) {
  const db = await getDb();
  await db.insert(messages).values({
    organizationId,
    conversationId,
    direction: "inbound",
    senderType: "client",
    body,
    whatsappMessageId,
  });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// WhatsApp's 24-hour customer service session window — free-form text is
// only permitted within 24h of the client's own most recent inbound
// message (see sendViaWhatsApp's own allowFreeform doc comment). Checked
// against messages.direction === "inbound" specifically, never
// conversations.updatedAt — that field is bumped by outbound sends too
// (see recordInboundMessage/sendOutboundMessage above), so it can't tell
// "the client wrote recently" apart from "Centro sent something recently."
// Used by src/lib/reminderContent.ts to decide whether a reminder can use
// natural free text or must fall back to a pre-approved Template.
export const FREEFORM_WINDOW_MS = 24 * 60 * 60 * 1000;

// The rule itself, over messages already in hand. The collection request
// page needs the same answer to decide whether offering a resend is honest,
// and it has the thread loaded — this keeps that decision and the send path
// from ever disagreeing about when the window is open.
export function isFreeformWindowOpen(
  thread: { direction: string; createdAt: Date }[],
  now: number = Date.now()
): boolean {
  let latest = 0;
  for (const message of thread) {
    if (message.direction !== "inbound") continue;
    latest = Math.max(latest, message.createdAt.getTime());
  }
  return latest > 0 && now - latest < FREEFORM_WINDOW_MS;
}

export async function isWithinFreeformSessionWindow(conversationId: string): Promise<boolean> {
  const db = await getDb();
  const [lastInbound] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return isFreeformWindowOpen(lastInbound ? [{ direction: "inbound", createdAt: lastInbound.createdAt }] : []);
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
  // snapshot (collectionRequestRequirements) — never a hardcoded list.
  // v2Enabled is THIS organization's own Meta template-approval state
  // (Phase 2.1 remediation) — never the old global flag, since Meta
  // approves a template per-WABA, not for every connected office at once.
  // An org that hasn't had centro_initial_request_v2 approved on its own
  // WABA yet safely gets the static, always-approved v1 template.
  const requirementNames = await getRequestRequirementNames(organizationId, collectionRequestId);

  // THIS organization's own approved DOCUMENT_REQUEST template, resolved by
  // intent. It used to be a hardcoded name gated on
  // organizations.initialRequestV2Approved — a hand-set boolean asserting
  // that a name Centro holds is approved on an office's WABA, which nothing
  // ever verified against Meta.
  const resolvedRequest = await resolveApprovedTemplate(organizationId, "DOCUMENT_REQUEST");
  if (!resolvedRequest.ok) {
    console.error("[whatsapp] no approved DOCUMENT_REQUEST template for organization", {
      organizationId,
      problem: resolvedRequest.problem,
    });
    await recordAuditEvent({
      organizationId,
      eventType: "conversation.initial_request_template_unavailable",
      description: `לא נשלחה פנייה ראשונית: ${resolvedRequest.reason}`,
      actorType: "system",
      collectionRequestId,
      metadata: { problem: resolvedRequest.problem },
    });
    return { conversation, sent: false };
  }

  const listParam = formatRequirementListForTemplateParam(requirementNames);
  const result = await sendOutboundMessage(
    organizationId,
    conversation.id,
    renderTemplateBody(resolvedRequest.template, [listParam]),
    "ai",
    trigger,
    {
      templateName: resolvedRequest.template.name,
      language: resolvedRequest.template.language,
      params: buildTemplateParams(resolvedRequest.template, [listParam]),
    }
  );

  // The retry-with-a-different-template fallback that used to live here is
  // gone. It existed because initialRequestV2Approved could be wrong, and it
  // retried with a second hardcoded name — which is no more likely to exist
  // on this office's WABA than the first. The template now comes from rows
  // synced from Meta, so a rejection is a real signal about that specific
  // approved template and is left visible rather than papered over with a
  // second send.
  return { conversation, sent: result.sent };
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
    .set({ status: "waiting_for_client", reminderAnchorAt: new Date() })
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
