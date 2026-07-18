import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  collectionRequests,
  conversations,
  documents,
  messages,
  organizations,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { isWithinBusinessHours } from "@/lib/businessHours";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";

/**
 * WhatsApp transport is mocked throughout this module (M6 swaps in the
 * real Business API — see sendOutboundMessage's single call site). All the
 * decision logic (Ch.10 conversation flow, Ch.16 automation rules) is
 * real and does not change when the transport does.
 */

const INITIAL_REQUEST_TEMPLATE =
  "שלום! זהו סנטרו, העוזר הדיגיטלי של המשרד. נשמח לקבל את המסמכים הנדרשים לתקופה הנוכחית.";
const THANK_YOU_TEMPLATE =
  "תודה, קיבלנו את המסמכים! האם סיימתם לשלוח את כל המסמכים? השיבו 'סיימתי' או 'יש עוד מסמכים'.";
const DUPLICATE_TEMPLATE = "קיבלנו מסמך זה כבר, תודה.";

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

// The one call site that will change when M6 wires the real WhatsApp
// Business API in place of this mock. BR-18.1 gating is real: outside
// business hours, automated ("ai") messages are held rather than sent —
// see the returned `held` flag, surfaced by callers.
export async function sendOutboundMessage(
  organizationId: string,
  conversationId: string,
  body: string,
  senderType: "ai" | "employee"
): Promise<{ sent: boolean }> {
  const db = await getDb();

  if (senderType === "ai") {
    const organization = await getOrganizationConfig(organizationId);
    if (!isWithinBusinessHours(organization)) {
      return { sent: false };
    }
  }

  await db.insert(messages).values({
    organizationId,
    conversationId,
    direction: "outbound",
    senderType,
    body,
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
export async function startConversation(
  organizationId: string,
  collectionRequestId: string,
  clientId: string
) {
  const conversation = await ensureConversation(
    organizationId,
    collectionRequestId,
    clientId
  );
  await sendOutboundMessage(
    organizationId,
    conversation.id,
    INITIAL_REQUEST_TEMPLATE,
    "ai"
  );
  return conversation;
}

// Simple identical-filename duplicate check (Ch.10 step 8). Smarter
// AI-based detection — renamed PDFs, re-scans — is Ch.9's job (M9); this
// is the deterministic floor that doesn't need a classifier.
export async function isDuplicateFileName(
  collectionRequestId: string,
  fileName: string
) {
  const db = await getDb();
  const existing = await db
    .select({ fileName: documents.fileName })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));
  return existing.some((doc) => doc.fileName === fileName);
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
