import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, conversations, documents, messages, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { classifyIntent } from "@/lib/ai/intentClassifier";
import { applyDocumentProfileConfirmation } from "@/lib/clientDocumentProfile";
import {
  CONFIRM_NO_BUTTON_ID,
  CONFIRM_YES_BUTTON_ID,
  listOpenConfirmationsForCollectionRequest,
  resolveBatchedIntakeReply,
  resolveConfirmationFromReply,
  resolveOpenClarificationReply,
} from "@/lib/pendingConfirmations";
import {
  applyClarificationReply,
  applyUnsolicitedConfirmationDecision,
} from "@/lib/documentIntakeReview";
import { applyIdentityAnomalyDecision } from "@/lib/documentIdentityVerification";
import { attemptFinishCollectionRequest, isFinishedSignal } from "@/lib/caseReview";
import { applyDeferralIfAny } from "@/lib/reminderDeferral";
import { classifyReopenIntent } from "@/lib/ai/conversationReplyIntent";
import { createRequestReopenConfirmation, applyRequestReopenDecision, decidePostCompletionGate } from "@/lib/requestReopen";
import { applyExtensionFinishedDecision } from "@/lib/requestExtension";
import { classifyRequestMessageIntent } from "@/lib/ai/requestMessageIntent";
import { answerRequestMessage, buildRequirementFacts } from "@/lib/requestQnA";
import { askWhichDocumentMissing, openRequirementException, resolveExceptionTarget } from "@/lib/requirementException";
import { recordInboundMessage, sendOutboundMessage } from "@/lib/conversationOrchestration";
import { processInboundAttachment, reprocessHeldReopenDocument } from "@/app/(app)/collections/conversationActions";
import { downloadMedia } from "@/lib/whatsapp/media";
import { toE164 } from "@/lib/whatsapp/phone";
import { verifyWebhookSignature } from "@/lib/whatsapp/webhookSignature";

export const dynamic = "force-dynamic";
// Smart notification grouping (pendingConfirmations.ts's
// flushDueIntakeNotifications) schedules a background wait — via
// scheduleAfterResponse/Next's after() — for the organization's grouping
// window (organizations.documentGroupingWindowSeconds, default 15s) before
// actually sending a batched confirmation question. after() only runs for
// as long as this route's own maxDuration allows; the platform default
// (10s on Vercel's Hobby tier) is shorter than the default grouping
// window, so without this the background flush would be killed before it
// ever sends. 30s comfortably covers the default window plus normal
// classification/upload work, and is well within every Vercel plan's
// maxDuration ceiling.
export const maxDuration = 30;

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

// A client's most recently active conversation — real inbound routing
// has no "which page is the employee looking at" context the way the
// DevTools simulator does, since Meta only reports which phone number
// sent what. Matches phone numbers by E.164 normalization since
// clients.phone has no fixed format. A client with several genuinely
// concurrent collection requests isn't disambiguated further than this —
// out of this milestone's scope.
async function findClientAndConversation(organizationId: string, fromWaId: string) {
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
  console.log("[wa-inbound] findClientAndConversation: phone match", {
    organizationId,
    fromWaIdLast4: fromWaId.slice(-4),
    candidateCount: orgClients.length,
    matched: !!client,
    clientId: client?.id ?? null,
  });
  if (!client) return null;

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.clientId, client.id)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  console.log("[wa-inbound] findClientAndConversation: conversation lookup", {
    clientId: client.id,
    conversationFound: !!conversation,
    conversationId: conversation?.id ?? null,
    collectionRequestId: conversation?.collectionRequestId ?? null,
  });
  if (!conversation) return null;

  return { client, conversation };
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
// Postgres unique_violation (SQLSTATE 23505). drizzle-orm wraps the raw
// driver error in its own error object with the original underneath
// `.cause` (confirmed empirically — checked both, not assumed), so both
// the top-level error and `.cause` are checked. `constraint_name` is
// populated by postgres-js against a real network Postgres server (what
// actually runs in production) but PGlite's driver layer leaves it
// undefined even though the same violation genuinely occurred (also
// confirmed empirically) — when absent, falls back to matching the
// constraint name inside the error message text, which both drivers
// include. Checking the specific index name (rather than any 23505) keeps
// this from ever accidentally swallowing an unrelated unique violation as
// if it were the expected idempotency race.
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    if ((candidate as { code?: unknown }).code !== "23505") continue;
    const actualConstraint = (candidate as { constraint_name?: unknown }).constraint_name;
    if (typeof actualConstraint === "string") return actualConstraint === constraintName;
    const message = (candidate as { message?: unknown }).message;
    return typeof message === "string" && message.includes(constraintName);
  }
  return false;
}

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
export function resolveInteractiveReplyText(message: WhatsAppInboundMessage): string | null {
  if (message.interactive?.type !== "button" || !message.interactive.button_reply) return null;
  const { id } = message.interactive.button_reply;
  if (id === CONFIRM_YES_BUTTON_ID) return "כן";
  if (id === CONFIRM_NO_BUTTON_ID) return "לא";
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

async function handleInboundMessage(
  organization: typeof organizations.$inferSelect,
  message: WhatsAppInboundMessage
) {
  console.log("[wa-inbound] handleInboundMessage ENTER", {
    organizationId: organization.id,
    messageId: message.id,
    type: message.type,
  });

  const match = await findClientAndConversation(organization.id, message.from);
  if (!match) {
    console.log("[wa-inbound] STOPPED: no matching client/conversation for this org — see phone match log above");
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_unmatched",
      description: `התקבלה הודעת WhatsApp ממספר לא מזוהה או ללא בקשת איסוף פעילה (${message.from})`,
      actorType: "system",
    });
    return;
  }
  const { client, conversation } = match;
  const collectionRequestId = conversation.collectionRequestId;

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

  if (attachment && (await isMessageAlreadyProcessed(message.id))) {
    console.log("[wa-inbound] SKIPPED (idempotency): this WhatsApp message already produced a document", {
      messageId: message.id,
    });
    return;
  }

  await recordInboundMessage(
    organization.id,
    conversation.id,
    body || (attachment ? `[קובץ: ${attachment.fileName}]` : "[הודעה מסוג לא נתמך]")
  );

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
    // Only actually invokes the AI classifier in the one case where its
    // result matters — see decidePostCompletionGate's own doc comment.
    const wantsReopen =
      openConfirmations.length === 0 && !attachment && body ? await classifyReopenIntent(body) : false;
    const decision = decidePostCompletionGate({
      conversationStatus: conversation.status,
      hasOpenConfirmations: openConfirmations.length > 0,
      hasAttachment: !!attachment,
      wantsReopen,
    });
    console.log("[wa-inbound] post-completion gate decision", { collectionRequestId, decision });

    if (decision === "stash_attachment" && attachment) {
      let media: Awaited<ReturnType<typeof downloadMedia>>;
      try {
        media = await downloadMedia(attachment.mediaId);
      } catch (error) {
        console.error("[wa-inbound] downloadMedia FAILED (post-completion reopen path)", error);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "whatsapp.inbound_media_download_failed",
          description: `הורדת קובץ מ-WhatsApp נכשלה (${attachment.fileName})`,
          actorType: "system",
          clientId: client.id,
          collectionRequestId,
        });
        return;
      }
      const db = await getDb();
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

  // Mirrors simulateInboundMessage's own intent-classification + pending-
  // confirmation-resolution block (conversationActions.ts) — kept as a
  // separate copy rather than a shared extraction, since the approved
  // plan explicitly leaves simulateInboundMessage itself unchanged.
  if (body) {
    console.log("[wa-inbound] customer reply received", {
      conversationId: conversation.id,
      collectionRequestId,
      bodyPreview: body.slice(0, 80),
    });
    const intent = await classifyIntent(body);
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "message.intent_classified",
      description: `הודעת הלקוח סווגה כ-${intent}`,
      actorType: "ai",
      clientId: client.id,
      collectionRequestId,
      metadata: { intent },
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
    // document_clarification is open-ended ("what document is this?"), not
    // yes/no — checked first, via its own resolver, so a reply describing
    // the document is never misread as a yes/no answer to some other
    // question. Everything else (document_profile_*, and the new
    // unsolicited_document — "did you mean to send this?") goes through
    // the generic yes/no resolver exactly as before.
    //
    // An explicit "סיימתי"/"finished" is never swallowed as the answer to
    // an open clarification, even when one happens to be pending (a real
    // scenario since needs_resend — documentIntakeReview.ts — now asks
    // about a problematic document immediately instead of waiting for
    // case-review time, so an unrelated "finished" can easily arrive while
    // one is still open) — resolveOpenClarificationReply has no semantic
    // gating at all (any non-empty reply counts as an answer, by design,
    // for a genuine document description), so without this check a client
    // saying "finished" would be filed as if it described the document.
    const clarificationResolved = isFinishedSignal(body) ? null : await resolveOpenClarificationReply(conversation.id, body);
    if (clarificationResolved) {
      console.log("[wa-inbound] clarification reply resolved", { pendingConfirmationId: clarificationResolved.id });
      await applyClarificationReply(clarificationResolved, body);
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "pending_confirmation.resolved",
        description: `הלקוח הבהיר לגבי המסמך: "${body}"`,
        actorType: "client",
        clientId: client.id,
        collectionRequestId,
        metadata: { kind: clarificationResolved.kind, status: clarificationResolved.status },
      });
    } else {
      const resolved = await resolveConfirmationFromReply(conversation.id, body);
      if (resolved) {
        console.log("[wa-inbound] confirmation reply resolved", { pendingConfirmationId: resolved.id, kind: resolved.kind, status: resolved.status });
        // Each is a no-op for any kind that isn't its own.
        await applyDocumentProfileConfirmation(resolved);
        await applyUnsolicitedConfirmationDecision(resolved);
        await applyIdentityAnomalyDecision(resolved);
        await applyRequestReopenDecision(resolved, reprocessHeldReopenDocument);
        await applyExtensionFinishedDecision(resolved);
        await recordAuditEvent({
          organizationId: organization.id,
          eventType: "pending_confirmation.resolved",
          description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} בקשת אישור: "${resolved.question}"`,
          actorType: "client",
          clientId: client.id,
          collectionRequestId,
          metadata: { kind: resolved.kind, status: resolved.status },
        });
      } else if (isFinishedSignal(body)) {
        // "Centro checks the case, not the document" (caseReview.ts) — the
        // real, primary trigger for the whole-case review: the client's
        // own words, not just the employee dashboard button.
        console.log("[wa-inbound] finished signal detected, running case review", { collectionRequestId });
        const outcome = await attemptFinishCollectionRequest({
          organizationId: organization.id,
          collectionRequestId,
          conversationId: conversation.id,
          clientId: client.id,
          actorType: "client",
        });
        console.log("[wa-inbound] case review outcome", { collectionRequestId, outcome });
      } else {
        // Free-text "I'll send it later" understanding, now including real
        // dated commitments ("אשלח ביום חמישי") as a stronger case than a
        // vague short-term promise ("אשלח בערב") — only reached once
        // nothing else claimed this message (no open confirmation, not a
        // finished signal). A no-op for the overwhelming majority of
        // ordinary messages; see applyDeferralIfAny's own doc comment.
        const promised = await applyDeferralIfAny({
          organizationId: organization.id,
          conversationId: conversation.id,
          collectionRequestId,
          clientId: client.id,
          replyText: body,
        });
        if (promised) {
          console.log("[wa-inbound] follow-up promise or dated deferral recognized", { collectionRequestId });
        } else {
          // Message-relevance gate — the final fallback, only reached once
          // every earlier resolver (open confirmation, "finished", "I'll
          // send it later") found nothing to claim. Centro is not a general
          // chatbot: it answers a question about the *active* document
          // request, routes an explicit "I don't have this document" to an
          // employee decision, and otherwise stays completely silent — see
          // classifyRequestMessageIntent's own doc comment.
          const facts = await buildRequirementFacts(collectionRequestId);
          const intent = await classifyRequestMessageIntent(
            body,
            facts.map((f) => f.description)
          );
          console.log("[wa-inbound] request-message intent classified", { collectionRequestId, category: intent.category });

          if (
            intent.category === "request_overview" ||
            intent.category === "receipt_check" ||
            intent.category === "supporting_document" ||
            intent.category === "file_format"
          ) {
            const answer = await answerRequestMessage(intent.category, collectionRequestId);
            await sendOutboundMessage(organization.id, conversation.id, answer, "ai", "manual", undefined, true);
          } else if (intent.category === "no_document_exception") {
            const outstanding = facts.filter((f) => !f.satisfied).map((f) => ({ id: f.id, name: f.description }));
            const target = resolveExceptionTarget(outstanding, intent.mentionedDocumentType);
            if (target.kind === "matched") {
              await openRequirementException({
                organizationId: organization.id,
                clientId: client.id,
                conversationId: conversation.id,
                collectionRequestId,
                requirementId: target.requirementId,
                clientWording: body,
              });
            } else if (target.kind === "ambiguous") {
              await askWhichDocumentMissing({ organizationId: organization.id, conversationId: conversation.id });
            }
            // "none_outstanding" — nothing is actually missing right now;
            // stay silent rather than open an exception against nothing.
          }
          // "unrelated" — the safe default: no reply, no state change,
          // message already recorded above for an employee to see.
        }
      }
    }
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
      description: `הורדת קובץ מ-WhatsApp נכשלה (${attachment.fileName})`,
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
      description: `עיבוד המסמך שהתקבל מהלקוח נכשל (${attachment.fileName})`,
      actorType: "system",
      clientId: client.id,
      collectionRequestId,
    });
  }
}

async function processWebhookPayload(payload: WhatsAppWebhookPayload) {
  const db = await getDb();

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

      // Delivery/read status updates for messages Centro itself sent.
      for (const status of value.statuses ?? []) {
        await db
          .update(messages)
          .set({ deliveryStatus: status.status })
          .where(eq(messages.whatsappMessageId, status.id));
      }

      // Each message gets its own try/catch — Meta can (and, per the
      // original bug report, sometimes does) batch several attachments
      // into one payload, or send several messages seconds apart. Before
      // this, a single throw from message N aborted the loop and silently
      // dropped every message after it in the same payload; a document
      // failure must never cost a sibling attachment its own chance to be
      // received.
      for (const message of value.messages ?? []) {
        try {
          await handleInboundMessage(organization, message);
        } catch (error) {
          console.error("[wa-inbound] handleInboundMessage FAILED (isolated — other messages in this payload still process)", {
            messageId: message.id,
            error,
          });
        }
      }
    }
  }
}

// The real inbound receiver — replaces the DevTools "simulate inbound
// message" form as the genuine source of real WhatsApp traffic (that
// simulator stays, unchanged, as a manual-override tool; see the
// WhatsApp plan). Meta requires a fast 2xx regardless of internal
// outcome — a slow or non-2xx response causes Meta to retry the same
// webhook repeatedly, multiplying duplicate-processing risk — so every
// failure below is caught and logged, never thrown back to Meta.
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
    await processWebhookPayload(payload);
  } catch (error) {
    console.error("[whatsapp-webhook] processing failed", error);
  }

  return NextResponse.json({ status: "ok" });
}
