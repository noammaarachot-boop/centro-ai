"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { classifyDocumentWithLearning, isFuzzyDuplicate, SUPPORTED_EXTENSIONS } from "@/lib/ai/documentClassifier";
import { applyDocumentProfileConfirmation } from "@/lib/clientDocumentProfile";
import { getLearnedDocumentPatterns } from "@/lib/documentLearning";
import {
  respondToPendingConfirmationManually,
  resolveConfirmationFromReply,
  resolveOpenClarificationReply,
} from "@/lib/pendingConfirmations";
import {
  applyClarificationReply,
  applyUnsolicitedConfirmationDecision,
  createClarificationRequest,
  createUnsolicitedDocumentConfirmation,
  resolveDocumentIntakeOutcome,
} from "@/lib/documentIntakeReview";
import {
  applyIdentityAnomalyDecision,
  buildIdentityReferencePool,
  createOrMergeIdentityAnomalyConfirmation,
  detectIdentityAnomaly,
  extractedIdentityForStorage,
  type IdentityAnomaly,
} from "@/lib/documentIdentityVerification";
import { classifyIntent } from "@/lib/ai/intentClassifier";
import { requireSession } from "@/lib/auth/session";
import { completeCollectionRequest } from "@/lib/collectionRequestStateMachine";
import {
  checkIntegrationStatus,
  DRIVE_NOT_READY_MESSAGE,
  WHATSAPP_NOT_READY_MESSAGE,
} from "@/lib/integrationRequirements";
import {
  ensureConversation,
  evaluateAndPrompt,
  recordInboundMessage,
  reopenIfCompleted,
  sendDuplicateAcknowledgement,
  sendOutboundMessage,
  startConversation,
} from "@/lib/conversationOrchestration";
import { uploadDocumentResiliently } from "@/lib/storage/driveAdapter";

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
//
// Product Evolution M9 ("WhatsApp and Google Drive are mandatory") — this
// is the actual "start the collection" moment (createCollectionRequest
// only ever prepares a draft), so it's the one place blocked with a clear,
// specific explanation rather than letting a send silently no-op the way
// sendOutboundMessage's own "not_connected" delivery status would
// otherwise produce.
export async function initiateConversation(collectionRequestId: string) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );

  const status = await checkIntegrationStatus(session.organizationId);
  if (!status.whatsappReady) {
    redirect(`/collections/${collectionRequestId}?error=${encodeURIComponent(WHATSAPP_NOT_READY_MESSAGE)}`);
  }
  if (!status.driveReady) {
    redirect(`/collections/${collectionRequestId}?error=${encodeURIComponent(DRIVE_NOT_READY_MESSAGE)}`);
  }

  // Human-initiated "Initiate" action — always delivers, never gated by
  // documentCollectionEnabled.
  await startConversation(session.organizationId, collectionRequestId, current.clientId, "manual");

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
    collectionRequestId,
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
  const manualRequirementId = String(formData.get("requirementId") ?? "");
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

  // Ch.9 Intent Detection: logged for visibility on every inbound text;
  // only ever informational here — it never blocks receiving an
  // attachment, and workflow automation is gated by the presence of a
  // file, not by this classification.
  if (body) {
    const intent = await classifyIntent(body);
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "message.intent_classified",
      description: `הודעת הלקוח סווגה כ-${intent}`,
      actorType: "ai",
      clientId: current.clientId,
      collectionRequestId,
      metadata: { intent },
    });

    // Milestone 5 (Ch.3 "Confirm") / Ch.6 3-way document intake — a no-op
    // unless there is actually an open confirmation waiting for this exact
    // conversation. document_clarification is open-ended (not yes/no), so
    // it's checked first via its own resolver; everything else (including
    // the new unsolicited_document kind) goes through the generic yes/no
    // resolver, same as before.
    const clarificationResolved = await resolveOpenClarificationReply(conversation.id, body);
    if (clarificationResolved) {
      await applyClarificationReply(clarificationResolved, body);
      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "pending_confirmation.resolved",
        description: `הלקוח הבהיר לגבי המסמך: "${body}"`,
        actorType: "client",
        clientId: current.clientId,
        collectionRequestId,
        metadata: { kind: clarificationResolved.kind, status: clarificationResolved.status },
      });
    } else {
      const resolved = await resolveConfirmationFromReply(conversation.id, body);
      if (resolved) {
        // Milestone 6 (Learn) — the only place a client's own reply
        // changes their document profile. Both are no-ops for any kind
        // that isn't their own.
        await applyDocumentProfileConfirmation(resolved);
        await applyUnsolicitedConfirmationDecision(resolved);
        await applyIdentityAnomalyDecision(resolved);
        await recordAuditEvent({
          organizationId: session.organizationId,
          eventType: "pending_confirmation.resolved",
          description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} בקשת אישור: "${resolved.question}"`,
          actorType: "client",
          clientId: current.clientId,
          collectionRequestId,
          metadata: { kind: resolved.kind, status: resolved.status },
        });
      }
    }
  }

  if (fileName) {
    await processInboundAttachment(
      session.organizationId,
      collectionRequestId,
      conversation.id,
      current.clientId,
      fileName,
      manualRequirementId || null
    );
  }

  redirect(`/collections/${collectionRequestId}`);
}

// Ch.11 pipeline (Validation -> OCR -> Classification -> Matching ->
// Storage -> Status Update), OCR/Classification mocked per
// src/lib/ai/documentClassifier.ts. `manualRequirementId`, when provided,
// is a human hint that bypasses classification entirely — modeling a
// case where an employee already knows the answer.
//
// `fileBytes`/`mimeType` are optional and, since M-WA-4, threaded
// straight into uploadDocumentResiliently exactly like addManualDocument
// already does — when the real WhatsApp webhook (src/app/api/webhooks/
// whatsapp/route.ts) supplies real downloaded bytes, those are what get
// stored in Drive; simulateInboundMessage below never has real bytes
// (it's a UI-driven filename-only stand-in), so it omits them and still
// gets the same honest placeholder as before. Exported for the webhook
// route to call directly.
export async function processInboundAttachment(
  organizationId: string,
  collectionRequestId: string,
  conversationId: string,
  clientId: string,
  fileName: string,
  manualRequirementId: string | null,
  fileBytes?: Buffer,
  mimeType?: string,
  // Set only for a real WhatsApp attachment (the webhook route's own
  // message.id/wamid) — the idempotency key that lets a redelivered
  // webhook be recognized and skipped instead of downloading/uploading the
  // same file twice. Null for the DevTools simulator and manual uploads,
  // which have no WhatsApp message to key off.
  whatsappMessageId?: string
) {
  const db = await getDb();

  // FR-11.2: unsupported file types are rejected automatically.
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!manualRequirementId && !SUPPORTED_EXTENSIONS.includes(extension)) {
    await sendOutboundMessage(
      organizationId,
      conversationId,
      "מצטערים, סוג הקובץ אינו נתמך. נא לשלוח PDF או תמונה (JPG/PNG).",
      "ai"
    );
    await recordAuditEvent({
      organizationId,
      eventType: "document.rejected_unsupported_type",
      description: `הקובץ "${fileName}" נדחה אוטומטית - סוג קובץ לא נתמך`,
      actorType: "ai",
      clientId,
      collectionRequestId,
    });
    return;
  }

  const existingDocuments = await db
    .select({ fileName: documents.fileName })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  // Ch.9 duplicate detection: fuzzy match on filename tokens (renamed
  // copies), not just an exact string match.
  if (existingDocuments.some((doc) => isFuzzyDuplicate(doc.fileName, fileName))) {
    await sendDuplicateAcknowledgement(organizationId, conversationId);
    await recordAuditEvent({
      organizationId,
      eventType: "document.duplicate_detected",
      description: `מסמך "${fileName}" זוהה ככפילות`,
      actorType: "ai",
      clientId,
      collectionRequestId,
    });
    return;
  }

  const requirements = await db
    .select({
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
      sourceRequirementId: collectionRequestRequirements.sourceRequirementId,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, collectionRequestId));

  let requirementId: string | null = manualRequirementId;
  type IntakeStatus =
    | "needs_review"
    | "approved"
    | "unsolicited_pending_confirmation"
    | "clarification_requested"
    | "identity_anomaly_pending_confirmation";
  // Preserves the pre-existing behavior for a manual hint (the DevTools
  // simulator's "assign to this requirement" option): classification is
  // bypassed, but the document still lands in needs_review pending an
  // employee's actual approve/reject via reviewDocument — "we know which
  // requirement" was never the same thing as "auto-approved." Only the
  // real classification branch below uses the new 3-way outcomes.
  let status: IntakeStatus = "needs_review";
  // Populated only for the "unsolicited" outcome — read after the document
  // row exists (the confirmation's payload needs its id).
  let unsolicitedDocumentType: string | null = null;
  // Smart identity/consistency verification — populated whenever the
  // document's own content doesn't line up with the client or a sibling
  // document already on this request, regardless of whether it otherwise
  // matched or was unsolicited (the right document type still says nothing
  // about whose document it actually is).
  let identityAnomaly: IdentityAnomaly | null = null;
  // Persisted on the document row only when extraction was confident enough
  // to trust as a future sibling-comparison reference (see
  // extractedIdentityForStorage's own gate) — never a low-confidence guess.
  let extractedIdentity: ReturnType<typeof extractedIdentityForStorage> = null;
  // What the AI called this document — used only to name the file when an
  // identity-anomaly document is later confirmed by the client (mirrors
  // unsolicitedDocumentType's own role for that flow).
  let identityDocumentType: string | null = null;

  if (!manualRequirementId) {
    // Ch.6 layer 1: this client's own confirmed history is checked before
    // the generic heuristic — see src/lib/documentLearning.ts.
    const learnedPatterns = await getLearnedDocumentPatterns(organizationId, clientId);
    const classification = await classifyDocumentWithLearning(
      fileName,
      requirements,
      learnedPatterns,
      fileBytes && mimeType ? { bytes: fileBytes, mimeType } : undefined
    );
    console.log("[wa-inbound] classification result", {
      collectionRequestId,
      fileName,
      readable: classification.readable,
      matchedRequirementId: classification.matchedRequirementId,
      confidence: classification.confidence,
      aiRan: classification.aiRan,
      aiIdentified: classification.aiIdentified,
    });

    // FR-11.3: unreadable documents get an automatic request for a
    // clearer copy instead of being filed at all.
    if (!classification.readable) {
      await sendOutboundMessage(
        organizationId,
        conversationId,
        "לא הצלחנו לקרוא את הקובץ שנשלח. נא לשלוח עותק ברור יותר.",
        "ai"
      );
      await recordAuditEvent({
        organizationId,
        eventType: "document.unreadable",
        description: `הקובץ "${fileName}" זוהה כלא קריא, נשלחה בקשה לעותק ברור`,
        actorType: "ai",
        clientId,
        collectionRequestId,
      });
      return;
    }

    const existingApproved = await db
      .select({ requirementId: documents.requirementId })
      .from(documents)
      .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "approved")));
    const approvedRequirementIds = new Set(existingApproved.map((d) => d.requirementId));
    const outstandingRequirementIds = requirements
      .map((r) => r.id)
      .filter((id) => !approvedRequirementIds.has(id));

    // Ch.6 3-way split (src/lib/documentIntakeReview.ts) — a document that
    // doesn't match anything open is not automatically needs_review
    // anymore: "identified but not needed" (asks the client if it was
    // intentional) and "genuinely unrecognized" (asks the client what it
    // is) are both resolved by the client, not an employee, before
    // needs_review is ever reached.
    const outcome = resolveDocumentIntakeOutcome(classification, outstandingRequirementIds);
    console.log("[wa-inbound] intake outcome", { collectionRequestId, outcome });
    extractedIdentity = extractedIdentityForStorage(classification);
    identityDocumentType = classification.aiDocumentType ?? null;

    // Smart identity/consistency verification: runs whenever the document
    // was actually identified (matched or unsolicited — "unrecognized"
    // already routes to its own clarification question, which has nothing
    // yet to compare identity against). Can override even a confident
    // "matched" outcome — see documentIdentityVerification.ts's own doc
    // comment.
    if (outcome.kind !== "unrecognized" && (classification.identityExtractionConfidence ?? 0) > 0) {
      const [clientRow] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1);
      const pool = await buildIdentityReferencePool(collectionRequestId, null, clientRow?.name ?? "");
      identityAnomaly = detectIdentityAnomaly(
        {
          extractedPersonName: classification.extractedPersonName ?? null,
          extractedIdNumber: classification.extractedIdNumber ?? null,
          extractedCompanyName: classification.extractedCompanyName ?? null,
          identityExtractionConfidence: classification.identityExtractionConfidence ?? 0,
        },
        pool
      );
      console.log("[wa-inbound] identity check", { collectionRequestId, identityAnomaly });
    }

    if (identityAnomaly) {
      status = "identity_anomaly_pending_confirmation";
      requirementId = null;
    } else if (outcome.kind === "matched") {
      requirementId = outcome.requirementId;
      status = "approved";
    } else if (outcome.kind === "unsolicited") {
      status = "unsolicited_pending_confirmation";
      unsolicitedDocumentType = outcome.documentType;
    } else {
      status = "clarification_requested";
    }

    await recordAuditEvent({
      organizationId,
      eventType: "document.classified",
      description: identityAnomaly
        ? `מסמך "${fileName}" זוהה, אך התגלתה אי-התאמת זהות (${identityAnomaly.kind}) — נשלחה שאלת אישור ללקוח`
        : outcome.kind === "matched"
          ? `מסמך "${fileName}" סווג ושויך לדרישה אוטומטית (ביטחון ${(outcome.confidence * 100).toFixed(0)}%)`
          : outcome.kind === "unsolicited"
            ? `מסמך "${fileName}" זוהה כ"${outcome.documentType}" — אינו נכלל ברשימת הדרישות הפתוחות, נשלחה שאלת אישור ללקוח`
            : `מסמך "${fileName}" לא זוהה בביטחון מספק — נשלחה בקשת הבהרה ללקוח`,
      actorType: "ai",
      clientId,
      collectionRequestId,
      metadata: { outcome, identityAnomaly },
    });
  }

  const [document] = await db
    .insert(documents)
    .values({
      organizationId,
      collectionRequestId,
      requirementId,
      fileName,
      status,
      // Held whenever real bytes exist, regardless of status — a
      // needs_review document has no other way to get its bytes back later
      // (WhatsApp never re-sends media, and Meta's own media URLs expire
      // long before a human gets around to reviewing), and Product
      // Evolution M9 ("Never Lose a Document") means an approved document
      // needs this too: uploadDocumentResiliently below is the only place
      // that ever clears it, and only once the Drive upload actually
      // succeeds, so a failure right after auto-approval can never
      // silently lose the file.
      ...(fileBytes ? { pendingFileContent: fileBytes, pendingFileMimeType: mimeType } : {}),
      ...(whatsappMessageId ? { whatsappMessageId } : {}),
      ...(extractedIdentity ?? {}),
    })
    .returning();

  await recordAuditEvent({
    organizationId,
    eventType: "document.received",
    description: fileBytes
      ? `מסמך "${fileName}" התקבל מהלקוח (וואטסאפ)`
      : `מסמך "${fileName}" התקבל מהלקוח (וואטסאפ, הדמיה)`,
    actorType: "client",
    clientId,
    collectionRequestId,
  });

  if (status === "approved") {
    await uploadDocumentResiliently(
      organizationId,
      clientId,
      document.id,
      document.fileName,
      collectionRequestId,
      fileBytes,
      mimeType
    );
  } else if (status === "unsolicited_pending_confirmation" && unsolicitedDocumentType) {
    // Never uploaded and never counted until the client actually confirms
    // it was intentional (applyUnsolicitedConfirmationDecision) — see
    // src/lib/documentIntakeReview.ts.
    await createUnsolicitedDocumentConfirmation({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
      documentType: unsolicitedDocumentType,
    });
  } else if (status === "clarification_requested") {
    await createClarificationRequest({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
    });
  } else if (status === "identity_anomaly_pending_confirmation" && identityAnomaly) {
    // Never uploaded and never counted until the client actually confirms
    // it — see documentIdentityVerification.ts's applyIdentityAnomalyDecision.
    await createOrMergeIdentityAnomalyConfirmation({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
      anomaly: identityAnomaly,
      documentType: identityDocumentType,
    });
  }

  const reopened = await reopenIfCompleted(organizationId, collectionRequestId);
  if (reopened) {
    await db
      .update(conversations)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }
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
    collectionRequestId,
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
    collectionRequestId,
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
    collectionRequestId,
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

// Milestone 5 — the employee-facing quick-action equivalent of
// markFinished/markMoreDocuments above, for a pending confirmation: a
// direct override an employee can use regardless of whether a real
// client reply ever arrives (WhatsApp is still mocked project-wide), same
// as every other client-quick-reply stand-in in this file.
export async function respondToConfirmation(
  collectionRequestId: string,
  pendingConfirmationId: string,
  confirmed: boolean
) {
  const session = await requireSession();
  const current = await getCollectionRequestOrRedirect(
    session.organizationId,
    collectionRequestId
  );

  const resolved = await respondToPendingConfirmationManually(
    session.organizationId,
    pendingConfirmationId,
    confirmed
  );
  if (resolved) {
    await applyDocumentProfileConfirmation(resolved);
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "pending_confirmation.resolved",
      description: `עובד סימן בקשת אישור כ"${confirmed ? "אושרה" : "נדחתה"}" בשם הלקוח: "${resolved.question}"`,
      actorType: "employee",
      actorUserId: session.userId,
      clientId: current.clientId,
      collectionRequestId,
      metadata: { kind: resolved.kind, status: resolved.status },
    });
  }

  redirect(`/collections/${collectionRequestId}`);
}
