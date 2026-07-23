import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, conversations, messages, organizations } from "@/db/schema";
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
  if (!client) return null;

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.clientId, client.id)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  if (!conversation) return null;

  return { client, conversation };
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
  const match = await findClientAndConversation(organization.id, message.from);
  if (!match) {
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

  if (!attachment) return;

  try {
    const media = await downloadMedia(attachment.mediaId);
    await processInboundAttachment(
      organization.id,
      collectionRequestId,
      conversation.id,
      client.id,
      attachment.fileName,
      null,
      media.bytes,
      media.mimeType
    );
  } catch (error) {
    console.error("[whatsapp-webhook] media download failed", error);
    await recordAuditEvent({
      organizationId: organization.id,
      eventType: "whatsapp.inbound_media_download_failed",
      description: `הורדת קובץ מ-WhatsApp נכשלה (${attachment.fileName})`,
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

      for (const message of value.messages ?? []) {
        await handleInboundMessage(organization, message);
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
