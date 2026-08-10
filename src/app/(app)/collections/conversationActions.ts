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
  flushDueIntakeNotifications,
  respondToPendingConfirmationManually,
  resolveBatchedIntakeReply,
  resolveConfirmationFromReply,
  resolveOpenClarificationReply,
} from "@/lib/pendingConfirmations";
import {
  applyClarificationReply,
  applyUnsolicitedConfirmationDecision,
  buildResendGuidanceMessage,
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
import { computeRequirementSatisfaction, extractedPeriodLabelForStorage } from "@/lib/documentQuantity";
import { computeContinuationConfidence, MIN_CONTINUATION_CONFIDENCE } from "@/lib/documentContinuation";
import { applyDocumentReplaceIntentIfCaptioned } from "@/lib/documentReplace";
import { mergeContinuationGroupToPdf } from "@/lib/documentMerge";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";
import {
  attemptFinishCollectionRequest,
  CASE_REVIEW_SILENCE_WINDOW_MS,
  isFinishedSignal,
  scheduleCaseReviewRelay,
} from "@/lib/caseReview";
import { scheduleAfterResponse } from "@/lib/scheduleAfterResponse";
import { withdrawStaleFinishedCheck } from "@/lib/requestExtension";
import { classifyIntent } from "@/lib/ai/intentClassifier";
import { requireSession } from "@/lib/auth/session";
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

    // Smart notification grouping's reply counterpart: once several
    // groups have actually been sent together in one combined message,
    // the client answers by number ("1", "1,3") rather than a bare yes/no
    // — checked before every other resolver, since with 2+ groups open a
    // bare "כן"/"לא" is genuinely ambiguous and none of the resolvers
    // below may guess which one it answers.
    const batchResolved = await resolveBatchedIntakeReply(conversation.id, body);
    if (batchResolved.length > 0) {
      for (const resolved of batchResolved) {
        await applyUnsolicitedConfirmationDecision(resolved);
        await applyIdentityAnomalyDecision(resolved);
        await recordAuditEvent({
          organizationId: session.organizationId,
          eventType: "pending_confirmation.resolved",
          description: `הלקוח ${resolved.status === "confirmed" ? "אישר" : "דחה"} קבוצה בהודעה מרוכזת: "${resolved.question}"`,
          actorType: "client",
          clientId: current.clientId,
          collectionRequestId,
          metadata: { kind: resolved.kind, status: resolved.status, groupIndex: resolved.groupIndex },
        });
      }
    } else {
    // Milestone 5 (Ch.3 "Confirm") / Ch.6 3-way document intake — a no-op
    // unless there is actually an open confirmation waiting for this exact
    // conversation. document_clarification is open-ended (not yes/no), so
    // it's checked first via its own resolver; everything else (including
    // the new unsolicited_document kind) goes through the generic yes/no
    // resolver, same as before.
    //
    // See the identical guard in the webhook route's own copy of this
    // logic for why isFinishedSignal is checked first — an explicit
    // "סיימתי" must never be swallowed as the answer to an unrelated open
    // clarification (resolveOpenClarificationReply has no semantic gating
    // at all; it accepts any non-empty reply as a genuine description).
    const clarificationResolved = isFinishedSignal(body) ? null : await resolveOpenClarificationReply(conversation.id, body);
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
      } else if (isFinishedSignal(body)) {
        // "Centro checks the case, not the document" (caseReview.ts) — the
        // client's own words are the real, primary trigger for the whole-
        // case review, not just the employee dashboard button.
        await attemptFinishCollectionRequest({
          organizationId: session.organizationId,
          collectionRequestId,
          conversationId: conversation.id,
          clientId: current.clientId,
          actorType: "client",
        });
      }
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
  whatsappMessageId?: string,
  // Document replace/supersede (src/lib/documentReplace.ts) — the text a
  // client attached to this exact file as its WhatsApp caption (e.g. "זה
  // מחליף את הקודם"). Null whenever there was none, or for any caller that
  // doesn't have one (the DevTools simulator, manual uploads).
  captionText?: string | null
) {
  const db = await getDb();

  // Tenant-consistency guard (Phase 1.2 remediation) — this function has no
  // session of its own (it's called both from an authenticated Server
  // Action and, unauthenticated by design, from the webhook route right
  // after Meta's signature is verified), so it can't require a session the
  // way most of this file's other actions do. What it CAN do is refuse to
  // act if the organizationId/clientId it was handed don't actually match
  // this collectionRequestId's own row — every real caller already derives
  // these three ids together from one already-validated source (the
  // webhook's own findClientAndConversation join, or this file's own
  // getCollectionRequestOrRedirect), so this never rejects a legitimate
  // call; it only refuses a future caller that mixed up ids across tenants.
  const [collectionRequestRow] = await db
    .select({
      organizationId: collectionRequests.organizationId,
      clientId: collectionRequests.clientId,
      extensionActive: collectionRequests.extensionActive,
    })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!collectionRequestRow || collectionRequestRow.organizationId !== organizationId || collectionRequestRow.clientId !== clientId) {
    console.error("[processInboundAttachment] organizationId/clientId does not match collectionRequestId's own row — refusing to process", {
      collectionRequestId,
      organizationId,
      clientId,
    });
    return;
  }
  // Post-completion extension flow (src/lib/requestExtension.ts) — while
  // active, a document arriving must never auto-complete/close the request
  // the instant it happens to satisfy every requirement (see the immediate-
  // completion block below): the client may still have more to add and
  // hasn't said so yet.
  const extensionActive = collectionRequestRow.extensionActive ?? false;

  // Silence-window case review (src/lib/caseReview.ts's
  // runAutomaticCaseStatusReview) — every attachment that reaches this
  // function at all (regardless of how it's later classified: approved,
  // held for review, unreadable, a duplicate, an unsupported type) is real
  // activity on this request, so it always pushes the "go quiet and then
  // summarize" deadline forward by the same fixed window. A burst of
  // several files each reset it in turn, so only the last one's deadline
  // ever actually matters — exactly the debounce the client-facing
  // behavior needs. Skipped entirely during an active post-completion
  // extension: that flow already has its own dedicated "סיימת להעלות?"
  // nudge (requestExtension.ts) on a completed request with no open
  // requirement list left for this mechanism to evaluate against.
  if (!extensionActive) {
    await db
      .update(conversations)
      .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
      .where(eq(conversations.id, conversationId));

    // Precise real-time trigger for the write above (scheduleCaseReviewRelay,
    // caseReview.ts) — deliberately started on EVERY document, not just the
    // first one in a burst. An earlier version only started one relay per
    // burst (skipped if a still-future pendingCaseReviewAt suggested one was
    // already in flight) — that broke in ordinary use: a real 3-document
    // burst spread over ~21 seconds pushed the actual due time to 120s+21s
    // past the FIRST document's own arrival, which exceeded that one relay's
    // fixed wait budget, so it gave up ~14 seconds before the real due time.
    // Every relay here only ever needs to cover ~2 minutes from ITS OWN
    // start (CASE_REVIEW_RELAY_MAX_WAIT_MS has comfortable margin over
    // that), regardless of how long the overall burst runs — a later
    // document's own relay always has a fresh, short budget to reliably
    // cover the tail even if an earlier one in the same burst times out.
    // Redundant relays in the same burst all race the exact same atomic
    // claim (see scheduleCaseReviewRelay's own doc comment) — cheap
    // (Fluid Compute doesn't charge for idle wait time) and always safe,
    // never a double-send.
    scheduleAfterResponse(() =>
      scheduleCaseReviewRelay({ organizationId, conversationId, collectionRequestId, clientId })
    );
  }

  // Smart notification grouping's lazy flush trigger: any new activity on
  // this request is a chance to notice an earlier batch (from a document
  // processed moments ago) has crossed its grouping window and is now due
  // — sent here, promptly, rather than waiting on the next cron tick. A
  // no-op whenever nothing is actually due yet (including the common case
  // of no open batch at all).
  await flushDueIntakeNotifications(organizationId, collectionRequestId);

  // FR-11.2: unsupported file types are rejected automatically.
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!manualRequirementId && !SUPPORTED_EXTENSIONS.includes(extension)) {
    // Direct reaction to the file the client just sent, within the same
    // session window — same allowFreeform/trigger reasoning as every other
    // reactive intake message (see sendViaWhatsApp's own doc comment).
    await sendOutboundMessage(
      organizationId,
      conversationId,
      "הקובץ הזה לא נתמך 🙁 אפשר לשלוח PDF או תמונה (JPG/PNG)?",
      "ai",
      "manual",
      undefined,
      true
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
  // copies), not just an exact string match. "Level 1" per the decision-
  // engine principle — the system resolves this alone, silently; the
  // client never even needs to know there was a dilemma, so no WhatsApp
  // message is sent (still fully audited below).
  if (existingDocuments.some((doc) => isFuzzyDuplicate(doc.fileName, fileName))) {
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
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
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
  // Smart identity/consistency verification — populated whenever the
  // document's own content doesn't line up with the client or a sibling
  // document already on this request, regardless of whether it otherwise
  // matched or was unsolicited (the right document type still says nothing
  // about whose document it actually is).
  let identityAnomaly: IdentityAnomaly | null = null;
  let identityClientName = "";
  // Persisted on the document row only when extraction was confident enough
  // to trust as a future sibling-comparison reference (see
  // extractedIdentityForStorage's own gate) — never a low-confidence guess.
  let extractedIdentity: ReturnType<typeof extractedIdentityForStorage> = null;
  // Quantity-aware requirement engine (src/lib/documentQuantity.ts) — the
  // dated period this document was extracted to cover, persisted only when
  // extraction was confident enough (same aiRan-gated discipline as
  // extractedIdentity above). Null for anything undated or below-threshold.
  let extractedPeriodLabel: string | null = null;
  // Multi-signal multi-page detection (src/lib/documentContinuation.ts) —
  // persisted whenever the AI extracted them, so a later document can be
  // scored against this one as a prior page, regardless of arrival timing.
  let extractedReferenceNumber: string | null = null;
  let pageNumberCurrent: number | null = null;
  let pageNumberTotal: number | null = null;
  // What the AI called this document — used only to name the file when an
  // identity-anomaly document is later confirmed by the client, and to
  // name the type in the immediate anomaly question itself (see
  // pendingIdentityAnomaly below).
  let identityDocumentType: string | null = null;
  // Immediate business-exception handling — a document that's the right
  // *type* but the wrong person (identity_anomaly) or a real, confidently-
  // identified document that just isn't one of the open requirements
  // (unsolicited) both need the client's own yes/no answer before anything
  // else can happen with them, exactly like needs_resend below. All three
  // are asked about right after the document row is inserted (needs its
  // id), never deferred to whole-case-review time — deferring a genuine
  // "does the system need something from you right now" question just
  // delays it for no benefit, unlike the 2-minute silence-window summary
  // (caseReview.ts), which is deliberately proactive/unprompted and so
  // deliberately waits for quiet. Each of these three still only ever
  // produces ONE combined message per short burst via the existing
  // notifyAfter grouping window (pendingConfirmations.ts) — "immediate"
  // means "not held for 2 minutes," not "one WhatsApp message per file."
  // matchedRequirementId: the requirement resolveDocumentIntakeOutcome
  // already confidently matched, BEFORE the identity check overrode it —
  // never a fresh guess, just carrying forward a decision already made at
  // the same confidence bar every ordinary auto-approval requires. Null
  // whenever the outcome wasn't "matched" at all (e.g. unsolicited or
  // needs_resend never reaches this branch, or the sole-outstanding
  // fallback didn't clear the bar) — nothing to carry forward, so a later
  // "yes" answer keeps today's behavior (filed as an unassociated extra).
  let pendingIdentityAnomaly: {
    anomaly: IdentityAnomaly;
    documentType: string | null;
    matchedRequirementId: string | null;
    // The raw name/company actually found ON this document — distinct
    // from anomaly.conflictingName, which for id_mismatch names a SIBLING
    // document's person, not this one's own. Used to phrase the explicit
    // "does this replace X?" question (documentIdentityVerification.ts).
    extractedPersonName: string | null;
    extractedCompanyName: string | null;
    clientName: string;
  } | null = null;
  let pendingUnsolicitedDocumentType: string | null = null;
  // Sent below when this document isn't usable as received at all (a real
  // quality defect, or genuinely unidentifiable) — the client can still fix
  // it right now while they're in the chat.
  let needsResendMessage: string | null = null;
  // Multi-page document merging — set when this document is another page
  // of an already-approved document rather than its own independent unit.
  // See findContinuationTarget below.
  let continuationOfDocumentId: string | null = null;

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
        "לא הצלחתי לקרוא את הקובץ 🙁 אפשר לשלוח שוב, בצילום קצת יותר ברור?",
        "ai",
        "manual",
        undefined,
        true
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
      .select({
        id: documents.id,
        requirementId: documents.requirementId,
        extractedPeriodLabel: documents.extractedPeriodLabel,
        extractedPersonName: documents.extractedPersonName,
        extractedCompanyName: documents.extractedCompanyName,
        extractedReferenceNumber: documents.extractedReferenceNumber,
        pageNumberCurrent: documents.pageNumberCurrent,
        pageNumberTotal: documents.pageNumberTotal,
        receivedAt: documents.receivedAt,
        continuationOfDocumentId: documents.continuationOfDocumentId,
      })
      .from(documents)
      .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "approved")));
    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts): a
    // requirement stops being "outstanding" only once its requiredCount
    // units are actually satisfied against the office user's own stated
    // meaning (computeRequirementSatisfaction), not the moment a single
    // document is approved for it — see src/lib/documentQuantity.ts. A
    // requirement with no parsed spec resolves to exactly the pre-semantic
    // one-document/distinct-period behavior, unchanged.
    const outstandingRequirementIds = requirements
      .filter((requirement) => {
        // Multi-page continuation pages (continuationOfDocumentId set) are
        // never counted as their own unit — only the document they're a
        // page of is.
        const docs = existingApproved
          .filter((doc) => doc.requirementId === requirement.id && !doc.continuationOfDocumentId)
          .map((doc) => ({ periodLabel: doc.extractedPeriodLabel, personName: doc.extractedPersonName }));
        return !computeRequirementSatisfaction(requirement, docs).satisfied;
      })
      .map((requirement) => requirement.id);

    // Multi-page document merging: a second confidently-matched document
    // for a requiredCount=1 requirement that already has one approved,
    // non-continuation document, arriving soon after, is far more likely to
    // be another page of the same document than a genuinely separate one —
    // requiredCount > 1 requirements (e.g. "3 תלושי שכר") are excluded
    // entirely, since a second match there is a genuinely separate unit.
    // Decided from the classification result below, once we know what it
    // actually matched. Confidence is scored from several corroborating
    // signals (src/lib/documentContinuation.ts) rather than arrival timing
    // alone, so the best-matching prior document — not just the most
    // recent one — is picked among candidates.
    function findContinuationTarget(
      matchedRequirementId: string,
      candidateSignals: {
        personName: string | null;
        companyName: string | null;
        referenceNumber: string | null;
        pageNumberCurrent: number | null;
        pageNumberTotal: number | null;
      }
    ): string | null {
      const requirement = requirements.find((r) => r.id === matchedRequirementId);
      if (!requirement || requirement.requiredCount !== 1) return null;
      const priorPages = existingApproved.filter(
        (doc) => doc.requirementId === matchedRequirementId && !doc.continuationOfDocumentId
      );
      let best: { id: string; score: number } | null = null;
      for (const prior of priorPages) {
        const score = computeContinuationConfidence(
          {
            personName: prior.extractedPersonName,
            companyName: prior.extractedCompanyName,
            referenceNumber: prior.extractedReferenceNumber,
            pageNumberCurrent: prior.pageNumberCurrent,
            pageNumberTotal: prior.pageNumberTotal,
            receivedAt: prior.receivedAt,
          },
          { ...candidateSignals, receivedAt: new Date() }
        );
        if (score >= MIN_CONTINUATION_CONFIDENCE && (!best || score > best.score)) {
          best = { id: prior.id, score };
        }
      }
      return best?.id ?? null;
    }

    // Ch.6 3-way split (src/lib/documentIntakeReview.ts) — a document that
    // doesn't match anything open is not automatically needs_review
    // anymore: "identified but not needed" (asks the client if it was
    // intentional) and "genuinely unrecognized" (asks the client what it
    // is) are both resolved by the client, not an employee, before
    // needs_review is ever reached.
    const outcome = resolveDocumentIntakeOutcome(classification, outstandingRequirementIds);
    console.log("[wa-inbound] intake outcome", { collectionRequestId, outcome });
    extractedIdentity = extractedIdentityForStorage(classification);
    extractedPeriodLabel = extractedPeriodLabelForStorage(classification);
    extractedReferenceNumber = classification.extractedReferenceNumber ?? null;
    pageNumberCurrent = classification.pageNumberCurrent ?? null;
    pageNumberTotal = classification.pageNumberTotal ?? null;
    identityDocumentType = classification.aiDocumentType ?? null;

    // Smart identity/consistency verification: runs whenever the document
    // was actually identified (matched or unsolicited — "needs_resend"
    // already routes to its own immediate resend request, which has
    // nothing reliable yet to compare identity against). Can override even
    // a confident "matched" outcome — see documentIdentityVerification.ts's
    // own doc comment.
    if (outcome.kind !== "needs_resend" && (classification.identityExtractionConfidence ?? 0) > 0) {
      const [clientRow] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1);
      identityClientName = clientRow?.name ?? "";
      const pool = await buildIdentityReferencePool(collectionRequestId, null, identityClientName);
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

    // Every business exception that genuinely needs the client's own
    // answer — needs_resend (checked first: there's nothing reliable to
    // check identity against on a file that isn't usable as received),
    // an identity anomaly, or an unsolicited-but-identified document — gets
    // an immediate reply. None of these wait for whole-case-review time;
    // see pendingIdentityAnomaly/pendingUnsolicitedDocumentType's own doc
    // comment above for why.
    if (outcome.kind === "needs_resend") {
      status = "clarification_requested";
      requirementId = null;
      needsResendMessage = buildResendGuidanceMessage(outcome, fileName);
    } else if (identityAnomaly) {
      status = "identity_anomaly_pending_confirmation";
      requirementId = null;
      pendingIdentityAnomaly = {
        anomaly: identityAnomaly,
        documentType: identityDocumentType,
        matchedRequirementId: outcome.kind === "matched" ? outcome.requirementId : null,
        extractedPersonName: classification.extractedPersonName ?? null,
        extractedCompanyName: classification.extractedCompanyName ?? null,
        clientName: identityClientName,
      };
    } else if (outcome.kind === "matched") {
      requirementId = outcome.requirementId;
      status = "approved";
      // Document replace/supersede (src/lib/documentReplace.ts): a
      // captioned message is a deliberate, distinct statement about this
      // exact file, never just another page of the same document — never
      // merge it as a continuation page (the two concepts are mutually
      // exclusive; see documents.supersededByDocumentId's own doc comment).
      continuationOfDocumentId = captionText
        ? null
        : findContinuationTarget(outcome.requirementId, {
            personName: classification.extractedPersonName ?? null,
            companyName: classification.extractedCompanyName ?? null,
            referenceNumber: classification.extractedReferenceNumber ?? null,
            pageNumberCurrent: classification.pageNumberCurrent ?? null,
            pageNumberTotal: classification.pageNumberTotal ?? null,
          });
      // "I don't have this document" exception (src/lib/requirementException.ts)
      // — a real matching document arriving after all clears any open
      // exception on this requirement automatically; the client found it,
      // there's nothing left for the employee to decide.
      const matchedRequirement = requirements.find((r) => r.id === outcome.requirementId);
      if (matchedRequirement?.exceptionStatus) {
        await db
          .update(collectionRequestRequirements)
          .set({ exceptionStatus: null, exceptionNote: null, exceptionCreatedAt: null })
          .where(eq(collectionRequestRequirements.id, outcome.requirementId));
      }
    } else if (outcome.kind === "unsolicited") {
      status = "unsolicited_pending_confirmation";
      pendingUnsolicitedDocumentType = outcome.documentType;
    }

    await recordAuditEvent({
      organizationId,
      eventType: "document.classified",
      description:
        outcome.kind === "needs_resend"
          ? `מסמך "${fileName}" ${outcome.reason === "unreadable_quality" ? "התקבל עם בעיית איכות" : "לא זוהה בביטחון מספק"} — נשלחה בקשת שליחה חוזרת מיידית`
          : identityAnomaly
            ? `מסמך "${fileName}" זוהה, אך התגלתה אי-התאמת זהות (${identityAnomaly.kind}) — הוחזק לבדיקת התיק בסיום האיסוף`
            : outcome.kind === "matched"
              ? `מסמך "${fileName}" סווג ושויך לדרישה אוטומטית (ביטחון ${(outcome.confidence * 100).toFixed(0)}%)`
              : `מסמך "${fileName}" זוהה כ"${outcome.documentType}" — אינו נכלל ברשימת הדרישות הפתוחות, הוחזק לבדיקת התיק בסיום האיסוף`,
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
      ...(extractedPeriodLabel ? { extractedPeriodLabel } : {}),
      ...(extractedReferenceNumber ? { extractedReferenceNumber } : {}),
      ...(pageNumberCurrent !== null ? { pageNumberCurrent } : {}),
      ...(pageNumberTotal !== null ? { pageNumberTotal } : {}),
      ...(continuationOfDocumentId ? { continuationOfDocumentId } : {}),
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

  if (needsResendMessage) {
    // Immediate, specific, AI-grounded (never a generic "couldn't read it").
    await createClarificationRequest({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
      question: needsResendMessage,
    });
  }

  if (pendingIdentityAnomaly) {
    // Immediate (not deferred to whole-case-review time) — still only ever
    // reaches the client as one combined message per short burst, via the
    // same notifyAfter grouping window every other batched confirmation
    // uses (see this function's own doc comment above).
    await createOrMergeIdentityAnomalyConfirmation({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
      anomaly: pendingIdentityAnomaly.anomaly,
      documentType: pendingIdentityAnomaly.documentType,
      matchedRequirementId: pendingIdentityAnomaly.matchedRequirementId,
      extractedPersonName: pendingIdentityAnomaly.extractedPersonName,
      extractedCompanyName: pendingIdentityAnomaly.extractedCompanyName,
      clientName: pendingIdentityAnomaly.clientName,
    });
  }

  if (pendingUnsolicitedDocumentType) {
    await createUnsolicitedDocumentConfirmation({
      organizationId,
      clientId,
      collectionRequestId,
      documentId: document.id,
      documentType: pendingUnsolicitedDocumentType,
    });
  }

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

    // Real single-PDF merging (src/lib/documentMerge.ts) — only ever
    // consulted when this document was itself confidently detected as
    // another page of an already-approved one (continuationOfDocumentId
    // set); a document's own first page never triggers this, since there's
    // nothing to merge with yet.
    if (continuationOfDocumentId) {
      await mergeContinuationGroupToPdf(organizationId, collectionRequestId, continuationOfDocumentId);
    }

    // Document replace/supersede (src/lib/documentReplace.ts) — only ever
    // consulted when the client actually attached a caption, and only ever
    // acts when that caption clearly says this replaces a prior document.
    if (requirementId && captionText) {
      await applyDocumentReplaceIntentIfCaptioned({
        organizationId,
        clientId,
        collectionRequestId,
        requirementId,
        newDocumentId: document.id,
        captionText,
      });
    }

    if (extensionActive) {
      // Post-completion extension flow (src/lib/requestExtension.ts) — the
      // client is actively adding documents after an already-completed
      // request; never auto-close on a single arriving document (they may
      // have more), and any still-open "did you finish?" question is now
      // stale — the client is clearly still active.
      await withdrawStaleFinishedCheck(collectionRequestId);
    } else {
      // "ברגע שכל הדרישות הושלמו... הבקשה נסגרת מיד" — closing never
      // depends on the reminder cycle or an explicit "finished" phrase: the
      // instant this document happens to be the last thing missing, the
      // request completes right here. checkCompletionGate is consulted
      // directly (never attemptFinishCollectionRequest blind) so a request
      // that's NOT yet satisfied never gets a "still missing X" message
      // after every single ordinary document — that's exactly the
      // per-document interruption "Centro checks the case, not the
      // document" rules out.
      const gateError = await checkCompletionGate(collectionRequestId);
      if (gateError === null) {
        const outcome = await attemptFinishCollectionRequest({
          organizationId,
          collectionRequestId,
          conversationId,
          clientId,
          actorType: "client",
        });
        // Just completed it ourselves this same call — reopenIfCompleted
        // below exists for a genuinely late document arriving on an
        // *already*-completed request, not this one; skip it so it doesn't
        // immediately undo the completion that just happened.
        if (outcome === "completed") return;
      }
    }
  }
  // unsolicited_pending_confirmation / clarification_requested /
  // identity_anomaly_pending_confirmation: never uploaded and never
  // counted — the question about each was already sent (or queued for
  // this burst's short grouping window) above, immediately, right after
  // the document row was inserted.

  const reopened = await reopenIfCompleted(organizationId, collectionRequestId);
  if (reopened) {
    await db
      .update(conversations)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }
}

// Post-completion intent gate (src/lib/requestReopen.ts) — the "process"
// half of applyRequestReopenDecision's callback contract. A document
// arriving on a closed conversation was stashed as a "reopen_pending_confirmation"
// placeholder row (see the webhook route) without ever being classified or
// uploaded; once the client confirms reopening, this is what actually runs
// it through the real intake pipeline for the first time — fetching the
// held bytes, deleting the placeholder (never left behind as a duplicate),
// then calling processInboundAttachment exactly as if the document had
// just arrived on an already-open request, which by this point it now is.
export async function reprocessHeldReopenDocument(documentId: string): Promise<void> {
  const db = await getDb();
  const [placeholder] = await db
    .select({
      organizationId: documents.organizationId,
      collectionRequestId: documents.collectionRequestId,
      fileName: documents.fileName,
      status: documents.status,
      pendingFileContent: documents.pendingFileContent,
      pendingFileMimeType: documents.pendingFileMimeType,
      whatsappMessageId: documents.whatsappMessageId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!placeholder) return;
  // State-consistency guard (Phase 1.2 remediation) — this function has no
  // organizationId of its own to check a caller-supplied id against (it
  // derives everything from the document row itself), so the real
  // protection is refusing to act on any document that isn't actually a
  // genuine reopen-placeholder row. A future caller passing an arbitrary
  // documentId can no longer make this function delete and reprocess a
  // real, already-classified document.
  if (placeholder.status !== "reopen_pending_confirmation") {
    console.error("[reprocessHeldReopenDocument] refusing — document is not a reopen placeholder", { documentId, status: placeholder.status });
    return;
  }

  const [collectionRequest] = await db
    .select({ clientId: collectionRequests.clientId })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, placeholder.collectionRequestId))
    .limit(1);
  if (!collectionRequest) return;

  const conversation = await ensureConversation(placeholder.organizationId, placeholder.collectionRequestId, collectionRequest.clientId);

  await db.delete(documents).where(eq(documents.id, documentId));

  await processInboundAttachment(
    placeholder.organizationId,
    placeholder.collectionRequestId,
    conversation.id,
    collectionRequest.clientId,
    placeholder.fileName,
    null,
    placeholder.pendingFileContent ?? undefined,
    placeholder.pendingFileMimeType ?? undefined,
    placeholder.whatsappMessageId ?? undefined
  );
}

// human_control's own document-staging counterpart to reprocessHeldReopenDocument
// above — same shape, different trigger: a document that arrived while an
// employee had this exact conversation taken over (never auto-classified,
// never auto-uploaded, no client-facing question asked while stashed —
// unlike reopen_pending_confirmation, the client already knows an employee
// is handling this manually). Called by releaseConversation once control
// returns to the AI, for every document stashed during that window.
export async function reprocessHeldHumanControlDocument(documentId: string): Promise<void> {
  const db = await getDb();
  const [placeholder] = await db
    .select({
      organizationId: documents.organizationId,
      collectionRequestId: documents.collectionRequestId,
      fileName: documents.fileName,
      status: documents.status,
      pendingFileContent: documents.pendingFileContent,
      pendingFileMimeType: documents.pendingFileMimeType,
      whatsappMessageId: documents.whatsappMessageId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!placeholder) return;
  // Same state-consistency guard as reprocessHeldReopenDocument above —
  // see its own comment for why this is the right protection here instead
  // of a session check.
  if (placeholder.status !== "human_control_pending") {
    console.error("[reprocessHeldHumanControlDocument] refusing — document is not a human-control placeholder", { documentId, status: placeholder.status });
    return;
  }

  const [collectionRequest] = await db
    .select({ clientId: collectionRequests.clientId })
    .from(collectionRequests)
    .where(eq(collectionRequests.id, placeholder.collectionRequestId))
    .limit(1);
  if (!collectionRequest) return;

  const conversation = await ensureConversation(placeholder.organizationId, placeholder.collectionRequestId, collectionRequest.clientId);

  await db.delete(documents).where(eq(documents.id, documentId));

  await processInboundAttachment(
    placeholder.organizationId,
    placeholder.collectionRequestId,
    conversation.id,
    collectionRequest.clientId,
    placeholder.fileName,
    null,
    placeholder.pendingFileContent ?? undefined,
    placeholder.pendingFileMimeType ?? undefined,
    placeholder.whatsappMessageId ?? undefined
  );
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

  await recordInboundMessage(session.organizationId, conversation.id, "סיימתי");

  // The employee-facing equivalent of the client texting "סיימתי" —
  // routes through the exact same whole-case review (caseReview.ts) a
  // real client message would, so a deferred exception is surfaced (and
  // grouped) here too instead of just failing on "missing requirements"
  // without explaining why.
  const outcome = await attemptFinishCollectionRequest({
    organizationId: session.organizationId,
    collectionRequestId,
    conversationId: conversation.id,
    clientId: current.clientId,
    actorType: "client",
  });

  if (outcome === "missing_requirements" || outcome === "blocked") {
    redirect(
      `/collections/${collectionRequestId}?error=${encodeURIComponent("הבקשה טרם הושלמה — יש לבדוק את השיחה עם הלקוח")}`
    );
  }
  // "review_pending": a grouped exception question was just sent to the
  // client — nothing more to do here but wait for their answer.

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
    "מעולה, ממתין למסמכים הנוספים 😊",
    "ai",
    "manual",
    undefined,
    true
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

  // Every document stashed while this exact conversation was in human_control
  // (never auto-classified/auto-uploaded at the time) is replayed through
  // the ordinary intake pipeline now that the AI is live again — reading
  // live, current state, never resuming from anything stale. No proactive
  // "welcome back"/summary message is sent here beyond whatever this
  // ordinary replay itself would produce — the AI never re-asks or re-sends
  // anything about ground the employee already covered manually.
  const stashed = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "human_control_pending")));
  for (const doc of stashed) {
    await reprocessHeldHumanControlDocument(doc.id);
  }

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
