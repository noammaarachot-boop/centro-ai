"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { collectionRequests, conversations, documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { completeCollectionRequest } from "@/lib/collectionRequestStateMachine";
import {
  ensureConversation,
  evaluateAndPrompt,
  isDuplicateFileName,
  recordInboundMessage,
  reopenIfCompleted,
  sendDuplicateAcknowledgement,
  sendOutboundMessage,
  startConversation,
} from "@/lib/conversationOrchestration";

async function getCollectionRequestOrRedirect(
  organizationId: string,
  collectionRequestId: string
) {
  const db = await getDb();
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!current || current.organizationId !== organizationId) {
    redirect("/collections");
  }
  return current;
}

// Ch.10 step 1: the initial outbound request. Also moves a still-draft
// request into `active`, since sending it is what actually starts the
// cycle.
export async function initiateConversation(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );

  await startConversation(session.organizationId, collectionRequestId, current.clientId);

  if (current.status === "draft") {
    const db = await getDb();
    await db
      .update(collectionRequests)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(collectionRequests.id, collectionRequestId));
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "conversation.initiated",
    description: "נשלחה פנייה ראשונית ללקוח",
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

// Stands in for an inbound WhatsApp webhook until M6. Optionally attaches
// a simulated document against a specific requirement, mirroring what a
// real upload would do (received status — still needs review, per BR-11.3
// / Ch.11's pipeline, whether that review is manual or, later, AI-driven).
export async function simulateInboundMessage(
  collectionRequestId: string,
  formData: FormData
) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const body = String(formData.get("body") ?? "").trim();
  const requirementId = String(formData.get("requirementId") ?? "");
  const fileName = String(formData.get("fileName") ?? "").trim();

  if (!body && !fileName) redirect(`/collections/${collectionRequestId}`);

  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  await recordInboundMessage(
    session.organizationId,
    conversation.id,
    body || `[מסמך: ${fileName}]`
  );

  if (fileName && requirementId) {
    const isDuplicate = await isDuplicateFileName(collectionRequestId, fileName);
    if (isDuplicate) {
      await sendDuplicateAcknowledgement(session.organizationId, conversation.id);
      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "document.duplicate_detected",
        description: `מסמך "${fileName}" זוהה ככפילות`,
        actorType: "system",
        clientId: current.clientId,
      });
    } else {
      const db = await getDb();
      await db.insert(documents).values({
        organizationId: session.organizationId,
        collectionRequestId,
        requirementId,
        fileName,
        status: "received",
      });

      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "document.received",
        description: `מסמך "${fileName}" התקבל מהלקוח (וואטסאפ, הדמיה)`,
        actorType: "client",
        clientId: current.clientId,
      });

      const reopened = await reopenIfCompleted(session.organizationId, collectionRequestId);
      if (reopened) {
        await db
          .update(conversations)
          .set({ status: "open", updatedAt: new Date() })
          .where(eq(conversations.id, conversation.id));
      }
    }
  }

  redirect(`/collections/${collectionRequestId}`);
}

// The manual stand-in for "N minutes of inactivity" firing (Ch.16 FR-16.4)
// — a real scheduler will call the same evaluateAndPrompt in M6.
export async function evaluateNow(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  const { prompted, reason } = await evaluateAndPrompt(
    session.organizationId,
    collectionRequestId,
    conversation.id
  );

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: prompted ? "conversation.evaluation_prompted" : "conversation.evaluation_silent",
    description: prompted
      ? "כל הדרישות מולאו — נשלחה בקשת אישור סיום ללקוח"
      : `הערכה בוצעה, אין פנייה ללקוח (${reason})`,
    actorType: "system",
    clientId: current.clientId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

// Ch.10 step 5/6: the client's quick-reply choice.
export async function markFinished(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  const db = await getDb();
  const result = await completeCollectionRequest(
    session.organizationId,
    undefined,
    "client",
    collectionRequestId
  );

  if (result.ok) {
    await db
      .update(conversations)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    await recordInboundMessage(session.organizationId, conversation.id, "סיימתי");
  } else {
    redirect(
      `/collections/${collectionRequestId}?error=${encodeURIComponent(result.error ?? "שגיאה")}`
    );
  }

  redirect(`/collections/${collectionRequestId}`);
}

export async function markMoreDocuments(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  const db = await getDb();
  await recordInboundMessage(session.organizationId, conversation.id, "יש עוד מסמכים");
  await db
    .update(conversations)
    .set({ status: "open", updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  if (current.status === "waiting_for_client" || current.status === "processing") {
    await db
      .update(collectionRequests)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(collectionRequests.id, collectionRequestId));
  }

  await sendOutboundMessage(
    session.organizationId,
    conversation.id,
    "בסדר, נמתין למסמכים הנוספים.",
    "ai"
  );

  redirect(`/collections/${collectionRequestId}`);
}

// FR-6.4: human takeover moves the conversation into Human Control and
// suspends automated outbound messages (BR-6.4) until released.
export async function takeOverConversation(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  const db = await getDb();
  await db
    .update(conversations)
    .set({ status: "human_control", updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "conversation.human_takeover",
    description: "עובד השתלט על השיחה",
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

export async function releaseConversation(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );

  const db = await getDb();
  await db
    .update(conversations)
    .set({ status: "open", updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "conversation.human_control_released",
    description: "השליטה האוטומטית בשיחה שוחזרה",
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

export async function sendEmployeeMessage(
  collectionRequestId: string,
  formData: FormData
) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );
  const body = String(formData.get("body") ?? "").trim();
  if (!body) redirect(`/collections/${collectionRequestId}`);

  const conversation = await ensureConversation(
    session.organizationId,
    collectionRequestId,
    current.clientId
  );
  await sendOutboundMessage(session.organizationId, conversation.id, body, "employee");

  redirect(`/collections/${collectionRequestId}`);
}
