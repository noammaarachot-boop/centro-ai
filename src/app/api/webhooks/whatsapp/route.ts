import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, conversations, documents, messages, organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { classifyIntent } from "@/lib/ai/intentClassifier";
import { applyDocumentProfileConfirmation } from "@/lib/clientDocumentProfile";
import { resolveConfirmationFromReply } from "@/lib/pendingConfirmations";
import { recordInboundMessage } from "@/lib/conversationOrchestration";
import { processInboundAttachment } from "@/app/(app)/collections/conversationActions";
import { downloadMedia } from "@/lib/whatsapp/media";
import { toE164 } from "@/lib/whatsapp/phone";
import { verifyWebhookSignature } from "@/lib/whatsapp/webhookSignature";

export const dynamic = "force-dynamic";

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
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
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

  const body = message.text?.body ?? null;
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

  // Mirrors simulateInboundMessage's own intent-classification + pending-
  // confirmation-resolution block (conversationActions.ts) — kept as a
  // separate copy rather than a shared extraction, since the approved
  // plan explicitly leaves simulateInboundMessage itself unchanged.
  if (body) {
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

    const resolved = await resolveConfirmationFromReply(conversation.id, body);
    if (resolved) {
      await applyDocumentProfileConfirmation(resolved);
      await recordAuditEvent({
        organizationId: organization.id,
        eventType: "pending_confirmation.resolved",
        description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} בקשת אישור: "${resolved.question}"`,
        actorType: "client",
        clientId: client.id,
        collectionRequestId,
        metadata: { kind: resolved.kind, status: resolved.status },
      });
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
      message.id
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
