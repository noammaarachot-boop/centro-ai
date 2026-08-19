import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, conversations, documents, messages, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import {
  CONFIRM_NO_BUTTON_ID,
  CONFIRM_YES_BUTTON_ID,
  listOpenConfirmationsForCollectionRequest,
  resolveBatchedIntakeReply,
} from "@/lib/pendingConfirmations";
import { applyUnsolicitedConfirmationDecision } from "@/lib/documentIntakeReview";
import { applyIdentityAnomalyDecision } from "@/lib/documentIdentityVerification";
import { classifyReopenIntent } from "@/lib/ai/conversationReplyIntent";
import { createRequestReopenConfirmation, decidePostCompletionGate, POST_COMPLETION_WINDOW_MS } from "@/lib/requestReopen";
import { understandConversationTurn } from "@/lib/conversation/conversationUnderstanding";
import { ensureConversation, recordInboundMessage } from "@/lib/conversationOrchestration";
import { ATTACHMENT_PLACEHOLDER_TEXT } from "@/lib/documents/displayLabel";
import { processInboundAttachment } from "@/app/(app)/collections/conversationActions";
import {
  createRequestDisambiguation,
  findOpenDisambiguationForClient,
  mostRecentlyActiveOpenConversation,
  resendDisambiguationClarification,
  resolveClientConversation,
  resolveDisambiguationReply,
  tryUnambiguousMatchByOpenQuestion,
  type DisambiguationResolution,
} from "@/lib/requestDisambiguation";
import { downloadMedia } from "@/lib/whatsapp/media";
import { toE164 } from "@/lib/whatsapp/phone";
import { verifyWebhookSignature } from "@/lib/whatsapp/webhookSignature";
import { claimWebhookMessage, markWebhookMessageCompleted, markWebhookMessageFailed } from "@/lib/webhookIdempotency";
import { isUniqueViolation } from "@/lib/db/errors";
import { captureError } from "@/lib/monitoring/errorReporting";
import { after } from "next/server";

export const dynamic = "force-dynamic";
// Was 30s, then 60s (this route's own earlier redelivery-incident fix —
// see webhook_message_claims's doc comment in schema.ts), then 150s, now
// 180s — specifically to give processInboundAttachment's own after()-based
// case-review relay (scheduleCaseReviewRelay, caseReview.ts) enough
// headroom to actually sleep out its own CASE_REVIEW_RELAY_MAX_WAIT_MS
// (150s) and still have time left to fire the summary in real time,
// instead of only relying on the external cron sweep's best-effort timing.
// This is NOT a guess: Fluid Compute is confirmed enabled on this exact
// production project (Vercel API, resourceConfig.fluid: true), whose docs
// put Hobby+Fluid's own ceiling at 300s — and a real after() task was
// measured actually completing a 100s sleep in production (well past the
// old 60s ceiling) before this was first raised, so this stays inside both
// the platform's documented limit and an empirically observed one, not
// just the documented one. None of this changes Meta's own experience:
// the claim-then-defer split below still returns 2xx the instant every
// message is claimed, long before either classification or
// the case-review wait even starts.
export const maxDuration = 180;

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
};

// Meta's one-time handshake when the webhook URL is saved in the App
// Dashboard — echoes hub.challenge back verbatim if hub.verify_token
// matches WHATSAPP_WEBHOOK_VERIFY_TOKEN, confirming this endpoint is
// really under Centro's control before Meta starts sending real events.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && challenge && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "verification-failed" }, { status: 403 });
}

interface WhatsAppInboundMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  // Document replace/supersede (src/lib/documentReplace.ts) — Meta lets a
  // client attach free text alongside media in the same message ("זה
  // מחליף את הקודם" as the caption of a newly-sent photo). Previously
  // never read at all.
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  // WhatsApp Interactive Reply Buttons — a client's tap on a button Centro
  // sent (see pendingConfirmations.ts's flushDueIntakeNotifications).
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: WhatsAppInboundMessage[];
        statuses?: Array<{ id: string; status: string }>;
      };
    }>;
  }>;
}

async function findOrganizationByPhoneNumberId(phoneNumberId: string) {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.whatsappPhoneNumberId, phoneNumberId))
    .limit(1);
  console.log("[wa-inbound] findOrganizationByPhoneNumberId", {
    phoneNumberId,
    matched: !!organization,
    organizationId: organization?.id ?? null,
  });
  return organization ?? null;
}

// Real inbound routing has no "which page is the employee looking at"
// context the way the DevTools simulator does, since Meta only reports
// which phone number sent what. Matches by E.164 normalization since
// clients.phone has no fixed format. Which of the matched client's
// possibly-several conversations a message belongs to is a separate
// decision — see resolveClientConversation (src/lib/requestDisambiguation.ts),
// consulted by handleInboundMessage below.
async function matchClientByPhone(organizationId: string, fromWaId: string) {
  const db = await getDb();
  const orgClients = await db
    .select({ id: clients.id, phone: clients.phone })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const target = `+${fromWaId}`;
  const client = orgClients.find((c) => toE164(c.phone) === target);
  // Last 4 digits only — matches the codebase's "no full phone numbers in
  // logs" convention (see document-collection-automation.md §12) while
  // still being enough to eyeball a match/mismatch against known test data.
  console.log("[wa-inbound] matchClientByPhone", {
    organizationId,
    fromWaIdLast4: fromWaId.slice(-4),
    candidateCount: orgClients.length,
    matched: !!client,
    clientId: client?.id ?? null,
  });
  return client ?? null;
}

// Idempotency check — Meta can and does redeliver the same webhook event
// (a slow ack, a transient error on our end), and without this a
// redelivered "image"/"document" event would download and upload the same
// file to Drive a second time. documents.whatsappMessageId is the ledger:
// a real WhatsApp attachment always sets it at insert time (see
// processInboundAttachment), so "does a document with this message id
// already exist" is a direct, reliable answer — not a heuristic. The
// unique partial index on that column (migration 0032) is the actual
// backstop against a true race (two redeliveries processed concurrently);
// this check is the fast path that avoids the redundant work in the
// overwhelmingly common case.
// Moved to src/lib/db/errors.ts (Phase 1.6 remediation) so wabaTokens.ts
// can reuse it too, without a lib module importing from a route file —
// re-exported below so route.test.ts's existing
// `import { isUniqueViolation } from "./route"` keeps working unchanged.
export { isUniqueViolation };

async function isMessageAlreadyProcessed(messageId: string): Promise<boolean> {
  const db = await getDb();
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.whatsappMessageId, messageId))
    .limit(1);
  return !!existing;
}

// WhatsApp Interactive Reply Buttons — a button tap has no message.text at
// all, only message.interactive.button_reply. Normalized here, once, into
// the exact same "כן"/"לא" free text every existing resolver
// (resolveConfirmationFromReply, resolveBatchedIntakeReply, isFinishedSignal)
// already understands — no separate button-aware resolution path needed
// anywhere else. An unrecognized button id (should never happen — Centro
// only ever sends its own two ids) resolves to null, same as no text at
// all, rather than guessing.
//
// The real production incident this fixes: every button tap silently
// failed to resolve, always falling through to "not a recognized button
// tap" — confirmed via the diagnostic logging below (added specifically
// to catch this) that Meta's actual webhook payload sets
// interactive.type to "button_reply", never "button". "button" was never
// a real value this field takes; it was a wrong assumption from day one,
// not a recent regression.
export function resolveInteractiveReplyText(message: WhatsAppInboundMessage): string | null {
  if (message.interactive?.type !== "button_reply" || !message.interactive.button_reply) {
    // Diagnostic only (no behavior change) — kept in place so any future
    // unresolved interactive payload shape is still fully logged instead
    // of silently guessed at.
    if (message.interactive) {
      console.log("[wa-inbound] unresolved interactive reply — not a recognized button tap", {
        interactiveType: message.interactive.type,
        hasButtonReply: !!message.interactive.button_reply,
        raw: message.interactive,
      });
    }
    return null;
  }
  const { id } = message.interactive.button_reply;
  if (id === CONFIRM_YES_BUTTON_ID) return "כן";
  if (id === CONFIRM_NO_BUTTON_ID) return "לא";
  console.log("[wa-inbound] unresolved interactive reply — unrecognized button id", { id });
  return null;
}

function resolveAttachment(
  message: WhatsAppInboundMessage
): { fileName: string; mimeType: string; mediaId: string } | null {
  if (message.type === "document" && message.document) {
    const fallbackExt = MIME_EXTENSIONS[message.document.mime_type] ?? "pdf";
    return {
      fileName: message.document.filename ?? `document_${message.id}.${fallbackExt}`,
      mimeType: message.document.mime_type,
      mediaId: message.document.id,
    };
  }
  if (message.type === "image" && message.image) {
    const extension = MIME_EXTENSIONS[message.image.mime_type] ?? "jpg";
    return {
      fileName: `image_${message.id}.${extension}`,
      mimeType: message.image.mime_type,
      mediaId: message.image.id,
    };
  }
  return null;
}

// Exported for route.test.ts only (Phase 4) — proves the real production
// entry point (not a paraphrase of it) now routes through
// understandConversationTurn, the same discipline already used for
// isUniqueViolation/resolveInteractiveReplyText below.
export async function handleInboundMessage(
  organization: typeof organizations.$inferSelect,
  message: WhatsAppInboundMessage
) {
  console.log("[wa-inbound] handleInboundMessage ENTER", {
    organizationId: organization.id,
    messageId: message.id,
    type: message.type,
  });

  const client = await matchClientByPhone(organization.id, message.from);
  if (!client) {
    console.log("[wa-inbound] STOPPED: no matching client for this org — see phone match log above");
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_unmatched",
      description: `התקבלה הודעת WhatsApp ממספר לא מזוהה (${message.from})`,
      actorType: "system",
    });
    return;
  }

  // Document replace/supersede (src/lib/documentReplace.ts) — Meta lets a
  // client attach free text alongside media in the same message.
  const captionText = message.image?.caption ?? message.document?.caption ?? null;
  const body = message.text?.body ?? resolveInteractiveReplyText(message) ?? captionText;
  const attachment = resolveAttachment(message);
  console.log("[wa-inbound] resolveAttachment", {
    messageType: message.type,
    attachmentFound: !!attachment,
    fileName: attachment?.fileName ?? null,
    mimeType: attachment?.mimeType ?? null,
  });

  // Multi-active-collection-request disambiguation (src/lib/requestDisambiguation.ts)
  // — checked BEFORE any conversation is chosen. A client already mid-way
  // through answering "which of your open requests is this about?" has
  // this exact reply consumed as the answer, never processed as a fresh
  // new message against a guessed conversation.
  const openDisambiguation = await findOpenDisambiguationForClient(organization.id, client.id);
  // Set only when an open disambiguation exists AND this specific reply
  // doesn't resolve it — production incident (2026-08-13): a client asked
  // a genuinely new question days after an unrelated disambiguation was
  // never answered, and got the exact same stale re-ask forever, since
  // nothing here ever expired or yielded. The disambiguation row itself is
  // deliberately left untouched (a later numbered/ordinal/named reply can
  // still resolve it normally) — this turn alone falls through to the
  // client's most recently active open conversation instead of asking
  // again, so a real, unrelated message is never stuck behind a stale
  // question the client may never answer in the expected format.
  let bypassConversation: typeof conversations.$inferSelect | null = null;
  if (openDisambiguation) {
    if (attachment && openDisambiguation.whatsappMessageId === message.id) {
      console.log("[wa-inbound] SKIPPED (idempotency): redelivery of the exact message already held for disambiguation", {
        messageId: message.id,
      });
      return;
    }
    const resolution = await resolveDisambiguationReply(openDisambiguation, body ?? "");
    if (resolution) {
      console.log("[wa-inbound] disambiguation resolved", {
        clientId: client.id,
        resolvedCollectionRequestId: resolution.collectionRequestId,
      });
      await replayHeldDisambiguation(organization, client, resolution);
      return;
    }
    console.log("[wa-inbound] open disambiguation exists but this reply doesn't resolve it — bypassing for this turn only (not re-asking, not deleting)", {
      clientId: client.id,
      disambiguationId: openDisambiguation.id,
    });
    bypassConversation = await mostRecentlyActiveOpenConversation(organization.id, client.id);
    if (!bypassConversation) {
      // Extremely defensive — an open disambiguation implies at least one
      // real conversation must already exist; if it somehow doesn't,
      // fall back to the original re-ask rather than silently drop this.
      await resendDisambiguationClarification(openDisambiguation);
      return;
    }
  }

  let conversation: typeof conversations.$inferSelect;
  if (bypassConversation) {
    conversation = bypassConversation;
  } else {
    const resolution = await resolveClientConversation(organization.id, client.id);
    if (resolution.outcome === "no_conversation") {
      console.log("[wa-inbound] STOPPED: client matched but has no collection request at all");
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "whatsapp.inbound_unmatched",
        description: `התקבלה הודעת WhatsApp מלקוח ללא בקשת איסוף פעילה (${message.from})`,
        actorType: "system",
        clientId: client.id,
      });
      return;
    }
    if (resolution.outcome === "resolved") {
      conversation = resolution.conversation;
    } else {
      // outcome === "ambiguous" — two or more genuinely active requests.
      console.log("[wa-inbound] multiple active collection requests", {
        clientId: client.id,
        candidateCount: resolution.candidates.length,
      });
      const unambiguous = await tryUnambiguousMatchByOpenQuestion(resolution.candidates);
      if (!unambiguous) {
        // Tier 3 — hold, ask, touch nothing on any candidate request.
        let attachmentContent: { fileName: string; mimeType: string; content: Buffer } | null = null;
        if (attachment) {
          try {
            const media = await downloadMedia(attachment.mediaId);
            attachmentContent = { fileName: attachment.fileName, mimeType: media.mimeType, content: media.bytes };
          } catch (error) {
            console.error("[wa-inbound] downloadMedia FAILED (disambiguation hold path)", error);
            await recordAuditEvent({
              organizationId: organization.id,
              eventType: "whatsapp.inbound_media_download_failed",
              description: "הורדת קובץ מ-WhatsApp נכשלה",
              actorType: "system",
              clientId: client.id,
            });
            return;
          }
        }
        try {
          await createRequestDisambiguation({
            organizationId: organization.id,
            clientId: client.id,
            candidates: resolution.candidates,
            messageBody: body,
            attachment: attachmentContent,
            whatsappMessageId: attachment ? message.id : null,
          });
        } catch (error) {
          // Race backstop — the partial unique index on
          // pendingRequestDisambiguations (one open question per client) is
          // the real guarantee behind the findOpenDisambiguationForClient
          // check above, which only ever sees a snapshot: two messages from
          // the same client processed by genuinely concurrent invocations
          // (two separate webhook deliveries, not two messages in the same
          // payload — those are handled sequentially by processClaimedMessages)
          // could both pass that check before either INSERT commits. Whichever
          // one loses the race never sent a second clarification (the insert
          // failed before sendOutboundMessage was ever reached) — the winner's
          // question already covers this client, so the losing message is
          // safely dropped rather than crashing the whole webhook attempt.
          if (isUniqueViolation(error, "pending_request_disambiguations_client_open_idx")) {
            console.log("[wa-inbound] SKIPPED (idempotency, race): another concurrent message already opened a disambiguation for this client", {
              clientId: client.id,
            });
            return;
          }
          throw error;
        }
        return;
      }
      console.log("[wa-inbound] disambiguation auto-resolved — exactly one candidate has an open question", {
        clientId: client.id,
        collectionRequestId: unambiguous.collectionRequestId,
      });
      const db = await getDb();
      const [resolvedConversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, unambiguous.conversationId))
        .limit(1);
      if (!resolvedConversation) return; // defensive — vanished between the two lookups above
      conversation = resolvedConversation;
    }
  }
  const collectionRequestId = conversation.collectionRequestId;

  if (attachment && (await isMessageAlreadyProcessed(message.id))) {
    console.log("[wa-inbound] SKIPPED (idempotency): this WhatsApp message already produced a document", {
      messageId: message.id,
    });
    return;
  }

  await recordInboundMessage(
    organization.id,
    conversation.id,
    // No classification has run yet at this point (that happens later, in
    // processInboundAttachment) — never the raw storage filename
    // (documents.fileName is WhatsApp-media-id-derived, not a human label;
    // see src/lib/documents/displayLabel.ts). A generic, honest placeholder
    // until the real document row (with its resolved displayLabel) exists.
    body || (attachment ? ATTACHMENT_PLACEHOLDER_TEXT : "[הודעה מסוג לא נתמך]")
  );

  // Human-control silencing gate (src/app/(app)/collections/conversationActions.ts's
  // takeOverConversation/releaseConversation) — checked BEFORE any other
  // processing, the instant the message is recorded. While an employee has
  // explicitly taken over this exact conversation, the bot never
  // auto-classifies, auto-replies, or resolves anything — a document
  // arriving is stashed (never auto-uploaded) for the employee to see when
  // they release control; a text message is only ever logged. Scoped to
  // this one conversation row alone (one client, one collection request) —
  // no other conversation is ever affected.
  if (conversation.status === "human_control") {
    if (attachment) {
      let media: Awaited<ReturnType<typeof downloadMedia>>;
      try {
        media = await downloadMedia(attachment.mediaId);
      } catch (error) {
        console.error("[wa-inbound] downloadMedia FAILED (human_control stash path)", error);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "whatsapp.inbound_media_download_failed",
          description: "הורדת קובץ מ-WhatsApp נכשלה",
          actorType: "system",
          clientId: client.id,
          collectionRequestId,
        });
        return;
      }
      const db = await getDb();
      await db.insert(documents).values({
        organizationId: organization.id,
        collectionRequestId,
        fileName: attachment.fileName,
        status: "human_control_pending",
        pendingFileContent: media.bytes,
        pendingFileMimeType: media.mimeType,
        whatsappMessageId: message.id,
      });
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "document.stashed_during_human_control",
        description: "מסמך התקבל בזמן שהשיחה בטיפול אנושי — לא עובד אוטומטית",
        actorType: "system",
        clientId: client.id,
        collectionRequestId,
      });
    }
    console.log("[wa-inbound] conversation is in human_control — message recorded, no automated processing", { collectionRequestId });
    return;
  }

  // Post-completion intent gate (src/lib/requestReopen.ts) — "Centro only
  // manages the conversation from the moment a request is sent until it's
  // finally completed." A closed conversation with nothing already pending
  // is never silently acted on: an attachment is stashed and asked about,
  // a text message is only acted on if it explicitly references the
  // finished request, and anything else is fully silent — no reply, no
  // state change, message already recorded above for an employee to see.
  // An already-open confirmation (most commonly this exact reopen
  // question, still awaiting an answer) is deliberately excluded here and
  // falls through to the normal resolver chain below instead.
  if (conversation.status === "closed") {
    const openConfirmations = await listOpenConfirmationsForCollectionRequest(collectionRequestId);
    // 48-hour post-completion grace window (POST_COMPLETION_WINDOW_MS,
    // requestReopen.ts) — started once at completedAt, never reset by later
    // activity. Past it, this whole mechanism stays silent regardless of
    // what the message contains (see decidePostCompletionGate).
    const db = await getDb();
    const [request] = await db
      .select({ completedAt: collectionRequests.completedAt })
      .from(collectionRequests)
      .where(eq(collectionRequests.id, collectionRequestId))
      .limit(1);
    const withinPostCompletionWindow = !!request?.completedAt && Date.now() - request.completedAt.getTime() <= POST_COMPLETION_WINDOW_MS;

    // Unified document-conversation understanding layer (Phase 1-4,
    // conversation-intelligence redesign) — a text-only message within the
    // window that refers to something already resolved on the just-completed
    // request (e.g. "שלחתי בטעות"), or any other document-related follow-up,
    // is understood here, before the coarser classifyReopenIntent boolean
    // gate below ever runs. No-op (handled: false) for anything it doesn't
    // recognize (UNRELATED or REASONING_FAILED — see understandConversationTurn's
    // own doc comment for why the latter never falls back to legacy
    // classification either) — classifyReopenIntent/the rest of this gate
    // then runs exactly as before.
    if (withinPostCompletionWindow && !attachment && body && openConfirmations.length === 0) {
      const { handled } = await understandConversationTurn({
        organizationId: organization.id,
        clientId: client.id,
        collectionRequestId,
        conversationId: conversation.id,
        messageText: body,
      });
      if (handled) return;
    }

    // Only actually invokes the AI classifier in the one case where its
    // result matters — see decidePostCompletionGate's own doc comment.
    const wantsReopen =
      openConfirmations.length === 0 && !attachment && body ? await classifyReopenIntent(body) : false;
    const decision = decidePostCompletionGate({
      conversationStatus: conversation.status,
      hasOpenConfirmations: openConfirmations.length > 0,
      hasAttachment: !!attachment,
      wantsReopen,
      withinPostCompletionWindow,
    });
    console.log("[wa-inbound] post-completion gate decision", { collectionRequestId, decision, withinPostCompletionWindow });

    if (decision === "stash_attachment" && attachment) {
      let media: Awaited<ReturnType<typeof downloadMedia>>;
      try {
        media = await downloadMedia(attachment.mediaId);
      } catch (error) {
        console.error("[wa-inbound] downloadMedia FAILED (post-completion reopen path)", error);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "whatsapp.inbound_media_download_failed",
          description: "הורדת קובץ מ-WhatsApp נכשלה",
          actorType: "system",
          clientId: client.id,
          collectionRequestId,
        });
        return;
      }
      const [placeholder] = await db
        .insert(documents)
        .values({
          organizationId: organization.id,
          collectionRequestId,
          fileName: attachment.fileName,
          status: "reopen_pending_confirmation",
          pendingFileContent: media.bytes,
          pendingFileMimeType: media.mimeType,
          whatsappMessageId: message.id,
        })
        .returning();
      await createRequestReopenConfirmation({
        organizationId: organization.id,
        clientId: client.id,
        collectionRequestId,
        documentId: placeholder.id,
      });
      return;
    }
    if (decision === "ask_reopen") {
      await createRequestReopenConfirmation({
        organizationId: organization.id,
        clientId: client.id,
        collectionRequestId,
        documentId: null,
      });
      return;
    }
    if (decision === "silent") {
      return; // no reply, no state change — message already recorded above.
    }
    // "fall_through" — not closed, or an existing pending confirmation is
    // still awaiting an answer; continue into the normal resolver chain.
  }

  // Mirrors simulateInboundMessage's own pending-confirmation-resolution
  // block (conversationActions.ts) — kept as a separate copy rather than a
  // shared extraction, matching correctionDispatch.ts's own precedent of
  // never touching an already-working branch for a change like this.
  if (body) {
    console.log("[wa-inbound] customer reply received", {
      conversationId: conversation.id,
      collectionRequestId,
      bodyLength: body.length,
    });

    // Smart notification grouping's reply counterpart: once several groups
    // have actually been sent together in one combined message, the client
    // answers by number ("1", "1,3") instead of a bare yes/no — checked
    // before every other resolver, since with 2+ groups open a bare
    // "כן"/"לא" is genuinely ambiguous and none of the resolvers below may
    // guess which one it answers.
    const batchResolved = await resolveBatchedIntakeReply(conversation.id, body);
    if (batchResolved.length > 0) {
      console.log("[wa-inbound] batched intake reply resolved", {
        groupCount: batchResolved.length,
        groupIndexes: batchResolved.map((r) => r.groupIndex),
      });
      for (const resolved of batchResolved) {
        await applyUnsolicitedConfirmationDecision(resolved);
        await applyIdentityAnomalyDecision(resolved);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "pending_confirmation.resolved",
          description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} קבוצה בהודעה מרוכזת: "${resolved.question}"`,
          actorType: "client",
          clientId: client.id,
          collectionRequestId,
          metadata: { kind: resolved.kind, status: resolved.status, groupIndex: resolved.groupIndex },
        });
      }
    } else {
      // Unified conversation-intelligence pipeline (Phase 1-4 — see
      // src/lib/conversation/) — the single authoritative decision point
      // for every remaining inbound text message: buildConversationContext
      // -> resolveConversationReference -> reasonAboutMessage -> exactly one
      // final disposition (ACT/ANSWER/CLARIFY/ESCALATE/UNRELATED/
      // REASONING_FAILED). Full context (open question of any kind,
      // confirmed durable focus, discourse entities, recent
      // documents/resolved decisions, recent messages, requirement facts,
      // organization info, active policies) is understood FIRST, before
      // anything commits to a specific interpretation. Every existing safe
      // action (pending-confirmation resolution, the correction layer,
      // requirement exceptions, deferral, finish) is reused as the
      // execution backend via validateAndExecuteAction's own deterministic
      // validation — this only decides which one to run and on what.
      // Always terminal for this turn — the legacy classifier
      // (classifyConversationIntent/conversationDispatch.ts) is never
      // invoked from this branch anymore, including on REASONING_FAILED
      // (see understandConversationTurn's own doc comment for why a
      // second AI call there would add no real resilience).
      const { handled, outcome } = await understandConversationTurn({
        organizationId: organization.id,
        clientId: client.id,
        collectionRequestId,
        conversationId: conversation.id,
        messageText: body,
      });
      console.log("[wa-inbound] conversation understanding outcome", { collectionRequestId, handled, outcome });
    }
  }

  if (!attachment) {
    console.log("[wa-inbound] no attachment on this message, done (text-only)");
    return;
  }

  let media: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    console.log("[wa-inbound] downloadMedia START", { mediaId: attachment.mediaId });
    media = await downloadMedia(attachment.mediaId);
    console.log("[wa-inbound] downloadMedia OK", {
      byteLength: media.bytes.length,
      mimeType: media.mimeType,
    });
  } catch (error) {
    console.error("[wa-inbound] downloadMedia FAILED", error);
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_media_download_failed",
      description: "הורדת קובץ מ-WhatsApp נכשלה",
      actorType: "system",
      clientId: client.id,
      collectionRequestId,
    });
    return;
  }

  try {
    console.log("[wa-inbound] processInboundAttachment START", {
      collectionRequestId,
      fileName: attachment.fileName,
    });
    await processInboundAttachment(
      organization.id,
      collectionRequestId,
      conversation.id,
      client.id,
      attachment.fileName,
      null,
      media.bytes,
      media.mimeType,
      message.id,
      captionText
    );
    console.log("[wa-inbound] processInboundAttachment DONE");
  } catch (error) {
    // The unique partial index on documents.whatsappMessageId (migration
    // 0032) is the hard backstop behind the isMessageAlreadyProcessed
    // fast-path check above — if two redeliveries of the exact same
    // message were somehow processed concurrently and both passed that
    // check, exactly one INSERT wins and the other hits this constraint.
    // That's a successful idempotency guarantee doing its job, not a
    // failure — surfacing it as whatsapp.inbound_processing_failed would
    // be a false alarm for something that behaved correctly.
    if (isUniqueViolation(error, "documents_whatsapp_message_id_idx")) {
      console.log("[wa-inbound] SKIPPED (idempotency, race): concurrent redelivery lost the insert race, as intended", {
        messageId: message.id,
      });
      return;
    }
    // Distinct from the download failure above — this is a genuinely
    // unexpected error (DB write, classification, or Drive upload throwing
    // instead of recording its own failure state), not the documented
    // "download failed" case. Kept separate so the audit trail and logs
    // never misattribute a processing bug as a download problem.
    console.error("[wa-inbound] processInboundAttachment FAILED", error);
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_processing_failed",
      description: "עיבוד המסמך שהתקבל מהלקוח נכשל",
      actorType: "system",
      clientId: client.id,
      collectionRequestId,
    });
  }
}

// Replays content held by createRequestDisambiguation once the client's
// reply resolves exactly which collection request it belongs to — the
// real intake pipeline runs for the first time here, exactly as if the
// content had just arrived on an already-unambiguous conversation. Mirrors
// reprocessHeldReopenDocument/reprocessHeldHumanControlDocument's own
// replay shape (src/app/(app)/collections/conversationActions.ts): the
// held bytes were already downloaded at hold time (a WhatsApp media URL
// is short-lived and might not still resolve by the time the client
// answers), so there's nothing left to fetch here.
async function replayHeldDisambiguation(
  organization: typeof organizations.$inferSelect,
  client: { id: string },
  resolution: DisambiguationResolution
) {
  const conversation = await ensureConversation(organization.id, resolution.collectionRequestId, client.id);
  const collectionRequestId = resolution.collectionRequestId;

  await recordInboundMessage(
    organization.id,
    conversation.id,
    // Same reasoning as the primary intake path above — no classification
    // result exists yet at this point, never the raw storage filename.
    resolution.messageBody || (resolution.pendingFileContent ? ATTACHMENT_PLACEHOLDER_TEXT : "[הודעה מסוג לא נתמך]")
  );

  // Human-control silencing gate — same rule as the live path (see its own
  // comment above): while an employee has this now-resolved conversation
  // taken over, the bot never auto-processes; a document is stashed, text
  // is only logged.
  if (conversation.status === "human_control") {
    if (resolution.pendingFileContent) {
      const db = await getDb();
      await db.insert(documents).values({
        organizationId: organization.id,
        collectionRequestId,
        fileName: resolution.fileName ?? "מסמך",
        status: "human_control_pending",
        pendingFileContent: resolution.pendingFileContent,
        pendingFileMimeType: resolution.pendingFileMimeType,
        whatsappMessageId: resolution.whatsappMessageId,
      });
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "document.stashed_during_human_control",
        description: "מסמך התקבל בזמן שהשיחה בטיפול אנושי — לא עובד אוטומטית",
        actorType: "system",
        clientId: client.id,
        collectionRequestId,
      });
    }
    console.log("[wa-inbound] disambiguation replay target is in human_control — recorded, no automated processing", { collectionRequestId });
    return;
  }

  // Post-completion gate — the resolved request can genuinely close between
  // the clarification question being asked and the client actually
  // answering it (an employee finishes it manually, or the scheduler
  // completes it because nothing was left missing). Blindly running
  // processInboundAttachment/understandConversationTurn here would bypass
  // the same "already completed" protection the live path enforces via its
  // own closed-conversation gate (decidePostCompletionGate) — reuse the
  // identical stash-and-ask mechanism instead of silently filing a document
  // or acting on a request that isn't open anymore.
  if (conversation.status === "closed") {
    const openConfirmations = await listOpenConfirmationsForCollectionRequest(collectionRequestId);
    if (openConfirmations.length === 0) {
      if (resolution.pendingFileContent) {
        const db = await getDb();
        const [placeholder] = await db
          .insert(documents)
          .values({
            organizationId: organization.id,
            collectionRequestId,
            fileName: resolution.fileName ?? "מסמך",
            status: "reopen_pending_confirmation",
            pendingFileContent: resolution.pendingFileContent,
            pendingFileMimeType: resolution.pendingFileMimeType,
            whatsappMessageId: resolution.whatsappMessageId,
          })
          .returning();
        await createRequestReopenConfirmation({
          organizationId: organization.id,
          clientId: client.id,
          collectionRequestId,
          documentId: placeholder.id,
        });
      } else {
        await createRequestReopenConfirmation({
          organizationId: organization.id,
          clientId: client.id,
          collectionRequestId,
          documentId: null,
        });
      }
    }
    console.log("[wa-inbound] disambiguation resolved to a request that has since completed — routed through the reopen gate, not auto-processed", { collectionRequestId });
    return;
  }

  if (resolution.messageBody) {
    const batchResolved = await resolveBatchedIntakeReply(conversation.id, resolution.messageBody);
    if (batchResolved.length > 0) {
      for (const resolved of batchResolved) {
        await applyUnsolicitedConfirmationDecision(resolved);
        await applyIdentityAnomalyDecision(resolved);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "pending_confirmation.resolved",
          description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} קבוצה בהודעה מרוכזת: "${resolved.question}"`,
          actorType: "client",
          clientId: client.id,
          collectionRequestId,
          metadata: { kind: resolved.kind, status: resolved.status, groupIndex: resolved.groupIndex },
        });
      }
    } else {
      await understandConversationTurn({
        organizationId: organization.id,
        clientId: client.id,
        collectionRequestId,
        conversationId: conversation.id,
        messageText: resolution.messageBody,
      });
    }
  }

  if (!resolution.pendingFileContent) return;

  try {
    await processInboundAttachment(
      organization.id,
      collectionRequestId,
      conversation.id,
      client.id,
      resolution.fileName ?? "מסמך",
      null,
      resolution.pendingFileContent,
      resolution.pendingFileMimeType ?? undefined,
      resolution.whatsappMessageId ?? undefined,
      resolution.messageBody
    );
  } catch (error) {
    if (isUniqueViolation(error, "documents_whatsapp_message_id_idx")) {
      console.log("[wa-inbound] SKIPPED (idempotency, race): concurrent redelivery lost the insert race, as intended (disambiguation replay)", {
        whatsappMessageId: resolution.whatsappMessageId,
      });
      return;
    }
    console.error("[wa-inbound] processInboundAttachment FAILED (disambiguation replay)", error);
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_processing_failed",
      description: "עיבוד המסמך שהתקבל מהלקוח נכשל",
      actorType: "system",
      clientId: client.id,
      collectionRequestId,
    });
  }
}

interface ClaimedMessage {
  organization: typeof organizations.$inferSelect;
  message: WhatsAppInboundMessage;
  claimId: string;
}

// Phase 1 — fast and fully synchronous: resolve which organization each
// change belongs to, apply cheap delivery-status updates inline, and
// atomically claim every real inbound message (webhookIdempotency.ts).
// Deliberately does none of the expensive work (classification, AI,
// outbound sends) — that's phase 2, run only after Meta already has its
// 2xx (see POST below). A message that loses its claim (already being
// processed by a still-live attempt, or already completed) is simply
// never added to the returned list — no error, no log spam beyond one
// line, since a Meta redelivery hitting this is the expected/desired case,
// not a failure.
async function claimWebhookPayload(payload: WhatsAppWebhookPayload): Promise<ClaimedMessage[]> {
  const db = await getDb();
  const claimed: ClaimedMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.metadata?.phone_number_id) continue;

      const statusCount = value.statuses?.length ?? 0;
      const messageCount = value.messages?.length ?? 0;
      console.log("[wa-inbound] webhook change received", {
        phoneNumberId: value.metadata.phone_number_id,
        statusCount,
        messageCount,
        messageTypes: (value.messages ?? []).map((m) => m.type),
      });

      const organization = await findOrganizationByPhoneNumberId(value.metadata.phone_number_id);
      if (!organization) {
        console.error(
          `[whatsapp-webhook] no organization connected to phone_number_id ${value.metadata.phone_number_id}`
        );
        continue;
      }

      // Delivery/read status updates for messages Centro itself sent —
      // cheap, no AI, safe to keep synchronous.
      for (const status of value.statuses ?? []) {
        await db
          .update(messages)
          .set({ deliveryStatus: status.status })
          .where(eq(messages.whatsappMessageId, status.id));
      }

      for (const message of value.messages ?? []) {
        const claim = await claimWebhookMessage(message.id);
        if (claim.outcome !== "claimed") {
          console.log("[wa-inbound] SKIPPED (claim)", { messageId: message.id, outcome: claim.outcome });
          continue;
        }
        claimed.push({ organization, message, claimId: claim.claimId });
      }
    }
  }

  return claimed;
}

// Phase 2 — the actual (slow) work, run in the background via after()
// once Meta already has its response. Each message keeps its own
// try/catch (Meta can batch several attachments into one payload, or send
// several messages seconds apart — a single throw must never cost a
// sibling message its own chance to be processed), and every outcome is
// recorded on its claim row: completed on success, failed (retryable —
// see webhookIdempotency.ts) on any error, so a genuine crash never
// leaves a message silently stuck as "processing" forever.
async function processClaimedMessages(claimedMessages: ClaimedMessage[]): Promise<void> {
  for (const { organization, message, claimId } of claimedMessages) {
    try {
      await handleInboundMessage(organization, message);
      await markWebhookMessageCompleted(claimId);
    } catch (error) {
      console.error("[wa-inbound] handleInboundMessage FAILED (isolated — other messages in this payload still process)", {
        messageId: message.id,
        error,
      });
      captureError(error, { organizationId: organization.id, messageId: message.id });
      await markWebhookMessageFailed(claimId, error);
    }
  }
}

// The real inbound receiver — replaces the DevTools "simulate inbound
// message" form as the genuine source of real WhatsApp traffic (that
// simulator stays, unchanged, as a manual-override tool; see the
// WhatsApp plan). Meta requires a fast 2xx regardless of internal
// outcome — a slow or non-2xx response causes Meta to retry the same
// webhook repeatedly (confirmed in production: a single slow AI
// classification call was enough to trigger 4 redeliveries of the same
// message over ~75 seconds). Claiming every message up front (fast, no
// AI) and deferring the actual processing to run after the response is
// sent means Meta's own retry timer never has a reason to fire in the
// first place, regardless of how long classification ends up taking.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid-signature" }, { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid-payload" }, { status: 400 });
  }

  try {
    const claimedMessages = await claimWebhookPayload(payload);
    if (claimedMessages.length > 0) {
      try {
        // Real production path: schedules the work to run after this
        // response is already sent — Meta's 2xx is never delayed by
        // classification, however long it takes.
        after(() => processClaimedMessages(claimedMessages));
      } catch {
        // after() requires an active request scope and throws without one
        // — the case for this route's own E2E suite (and any other test)
        // that calls POST directly with no real Next.js request context.
        // Falling back to processing inline (still before this function
        // returns) keeps those tests' synchronous "POST, then assert on
        // the outcome" pattern working exactly as it did before the
        // claim/defer restructuring; production always has a real request
        // scope on this route, so this branch never runs there.
        await processClaimedMessages(claimedMessages);
      }
    }
  } catch (error) {
    console.error("[whatsapp-webhook] claim phase failed", error);
    captureError(error, { phase: "claim" });
  }

  return NextResponse.json({ status: "ok" });
}
