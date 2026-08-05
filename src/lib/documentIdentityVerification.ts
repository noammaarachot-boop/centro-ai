import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, organizations, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import type { DocumentClassification } from "@/lib/ai/documentClassifier";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { createPendingConfirmation, type PendingConfirmationKind } from "@/lib/pendingConfirmations";
import { fileExtension, uploadDocumentResiliently } from "@/lib/storage/driveAdapter";

/**
 * Smart identity/consistency verification — a document can be exactly the
 * right *type* (a real תעודת זהות, sent for a תעודת זהות requirement) and
 * still be wrong: someone else's ID, a different ID number than the rest of
 * the request's documents, a document that belongs to another company. This
 * module is a check that runs *in addition to* (never instead of)
 * resolveDocumentIntakeOutcome in documentIntakeReview.ts — it can override
 * even a confident "matched" outcome, since matching the right document type
 * says nothing about whose document it actually is.
 *
 * Never a silent guess: below a confidence floor, or when nothing was
 * reliably extractable at all, this stays out of the way entirely rather
 * than accuse a client of sending someone else's document on shaky OCR.
 */

// Below this, the vision model's own identity extraction is too unreliable
// to act on at all — no anomaly is ever raised, matching/upload proceeds as
// if identity had never been checked.
const MIN_EXTRACTION_CONFIDENCE = 0.5;
// ID-number comparison is exact (no fuzzy tolerance for the number itself),
// so it needs a higher extraction bar than name comparison — a single
// misread digit from a lower-confidence OCR pass would otherwise produce a
// false accusation.
const MIN_ID_EXTRACTION_CONFIDENCE = 0.7;
// A name-match score at/above this counts as "the same person" — full/
// partial spelling, reversed word order and small OCR/spelling slips all
// still clear this bar (see nameMatchScore below). Never open an exception
// for a marginal difference alone.
const NAME_MATCH_THRESHOLD = 0.6;
// Below this, the mismatch is confident enough to name the conflicting
// person/company outright in the question. Between this and
// NAME_MATCH_THRESHOLD is a genuinely ambiguous case — ask a general
// "can you confirm this is yours?" instead of asserting it belongs to
// someone else.
const NAME_CONFIDENT_MISMATCH_CEILING = 0.35;

export interface IdentityAnomaly {
  kind: "name_mismatch" | "id_mismatch" | "company_mismatch";
  // true: confident enough to name the conflicting person/company/ID in the
  // question. false: genuinely ambiguous — softer, generic wording, no
  // guess asserted.
  confident: boolean;
  conflictingName: string | null;
  // Last 4 digits only — never the full ID number, in a question, a log, or
  // anywhere else outside the database itself.
  maskedIdNumber: string | null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = temp;
    }
  }
  return row[n];
}

function normalizeNameTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Tolerant of reversed first/last name order (tokens compared as a set, not
// positionally), minor OCR/spelling noise (per-token edit distance), and
// full-vs-partial spelling (a token counting as matched needs only be
// "close enough", not identical). Returns 0-1; a name present in only one
// of the two inputs scores 0. Exported for direct unit testing.
export function nameMatchScore(nameA: string, nameB: string): number {
  const tokensA = normalizeNameTokens(nameA);
  const tokensB = normalizeNameTokens(nameB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const usedLonger = new Set<number>();
  let totalScore = 0;
  for (const token of shorter) {
    let best = 0;
    let bestIndex = -1;
    longer.forEach((candidate, index) => {
      if (usedLonger.has(index)) return;
      const sim = tokenSimilarity(token, candidate);
      if (sim > best) {
        best = sim;
        bestIndex = index;
      }
    });
    // Very short tokens (single initials, 2-letter words) need an exact
    // match — a single edit distance is too large a fraction of them to
    // trust as "the same word" rather than coincidence.
    const requiredSim = token.length <= 2 ? 1 : 0.6;
    if (bestIndex >= 0 && best >= requiredSim) {
      usedLonger.add(bestIndex);
      totalScore += best;
    }
  }
  return totalScore / shorter.length;
}

function maskIdNumber(idNumber: string): string {
  return idNumber.length <= 4 ? idNumber : `***${idNumber.slice(-4)}`;
}

export interface IdentityCheckInput {
  extractedPersonName: string | null;
  extractedIdNumber: string | null;
  extractedCompanyName: string | null;
  identityExtractionConfidence: number;
}

export interface IdentityReferencePool {
  clientName: string;
  // Distinct person/company names already established for this request —
  // from sibling documents that were never themselves flagged as an
  // identity anomaly (see REFERENCE_STATUSES below). A document the client
  // later confirmed as "sent on purpose anyway" is deliberately excluded:
  // confirming one exception must never silently make a second, unrelated
  // exception look consistent.
  siblingPersonNames: string[];
  siblingIdNumbers: Array<{ idNumber: string; personName: string | null }>;
  siblingCompanyNames: string[];
}

// The single decision point: does this document's extracted identity line
// up with the client and the rest of this request's documents? Pure, no DB
// access, easily unit-tested — mirrors resolveDocumentIntakeOutcome's own
// shape in documentIntakeReview.ts.
export function detectIdentityAnomaly(
  input: IdentityCheckInput,
  pool: IdentityReferencePool
): IdentityAnomaly | null {
  if (input.identityExtractionConfidence < MIN_EXTRACTION_CONFIDENCE) return null;

  if (
    input.extractedIdNumber &&
    input.identityExtractionConfidence >= MIN_ID_EXTRACTION_CONFIDENCE &&
    pool.siblingIdNumbers.length > 0
  ) {
    const conflicting = pool.siblingIdNumbers.find((s) => s.idNumber !== input.extractedIdNumber);
    if (conflicting) {
      return {
        kind: "id_mismatch",
        confident: true,
        conflictingName: conflicting.personName,
        maskedIdNumber: maskIdNumber(conflicting.idNumber),
      };
    }
  }

  if (input.extractedPersonName) {
    const referenceNames = [pool.clientName, ...pool.siblingPersonNames].filter(Boolean);
    if (referenceNames.length > 0) {
      const bestScore = Math.max(...referenceNames.map((ref) => nameMatchScore(input.extractedPersonName!, ref)));
      if (bestScore < NAME_MATCH_THRESHOLD) {
        const confident = bestScore < NAME_CONFIDENT_MISMATCH_CEILING;
        return {
          kind: "name_mismatch",
          confident,
          conflictingName: confident ? input.extractedPersonName : null,
          maskedIdNumber: null,
        };
      }
    }
  }

  if (input.extractedCompanyName && pool.siblingCompanyNames.length > 0) {
    const bestScore = Math.max(
      ...pool.siblingCompanyNames.map((ref) => nameMatchScore(input.extractedCompanyName!, ref))
    );
    if (bestScore < NAME_MATCH_THRESHOLD) {
      const confident = bestScore < NAME_CONFIDENT_MISMATCH_CEILING;
      return {
        kind: "company_mismatch",
        confident,
        conflictingName: confident ? input.extractedCompanyName : null,
        maskedIdNumber: null,
      };
    }
  }

  return null;
}

// A document only ever joins the reference pool once it's past the
// pending/rejected identity-anomaly states — an unresolved or rejected
// anomaly is exactly the kind of thing that must never quietly become the
// new "established" identity for the request.
const REFERENCE_STATUSES = new Set([
  "received",
  "processing",
  "approved",
  "unsolicited_pending_confirmation",
  "unsolicited_approved",
  "clarification_requested",
]);

export async function buildIdentityReferencePool(
  collectionRequestId: string,
  // null when checked before the document row itself exists yet (the
  // normal case — see processInboundAttachment, which checks identity
  // before insert) — nothing needs excluding in that case.
  excludeDocumentId: string | null,
  clientName: string
): Promise<IdentityReferencePool> {
  const db = await getDb();
  const siblings = await db
    .select({
      status: documents.status,
      extractedPersonName: documents.extractedPersonName,
      extractedIdNumber: documents.extractedIdNumber,
      extractedCompanyName: documents.extractedCompanyName,
    })
    .from(documents)
    .where(
      excludeDocumentId
        ? and(eq(documents.collectionRequestId, collectionRequestId), ne(documents.id, excludeDocumentId))
        : eq(documents.collectionRequestId, collectionRequestId)
    );

  const reference = siblings.filter((s) => REFERENCE_STATUSES.has(s.status));

  return {
    clientName,
    siblingPersonNames: [...new Set(reference.map((s) => s.extractedPersonName).filter((n): n is string => !!n))],
    siblingIdNumbers: reference
      .filter((s): s is typeof s & { extractedIdNumber: string } => !!s.extractedIdNumber)
      .map((s) => ({ idNumber: s.extractedIdNumber, personName: s.extractedPersonName })),
    siblingCompanyNames: [
      ...new Set(reference.map((s) => s.extractedCompanyName).filter((n): n is string => !!n)),
    ],
  };
}

// Only ever called once real, above-floor extraction actually happened —
// callers must gate on identityExtractionConfidence themselves before
// persisting (see conversationActions.ts), so a low-confidence guess never
// becomes another document's "established" reference identity.
export function extractedIdentityForStorage(classification: DocumentClassification): {
  extractedPersonName: string | null;
  extractedIdNumber: string | null;
  extractedCompanyName: string | null;
} | null {
  if (!classification.aiRan || (classification.identityExtractionConfidence ?? 0) < MIN_EXTRACTION_CONFIDENCE) {
    return null;
  }
  return {
    extractedPersonName: classification.extractedPersonName ?? null,
    extractedIdNumber: classification.extractedIdNumber ?? null,
    extractedCompanyName: classification.extractedCompanyName ?? null,
  };
}

// Tailored wording per anomaly kind/confidence — never a generic "something
// doesn't match" message. `documentCount` > 1 only ever happens via the
// grouping path below (several documents already folded into the same
// still-open question).
function buildAnomalyQuestion(anomaly: IdentityAnomaly, documentCount: number): string {
  const plural = documentCount > 1;
  const countPhrase = plural ? `${documentCount} מסמכים` : "מסמך";

  let statement: string;
  if (anomaly.kind === "id_mismatch") {
    statement = `זיהינו ש${plural ? "במספר מסמכים" : "במסמך"} ששלחת מופיע מספר זהות שונה מהמסמכים הקודמים שהתקבלו בבקשה הזאת (מסתיים ב-${anomaly.maskedIdNumber}).`;
  } else if (anomaly.kind === "name_mismatch") {
    statement = anomaly.confident
      ? `זיהינו ש${countPhrase} ששלחת ${plural ? "מופיעים" : "מופיע"} על שם ${anomaly.conflictingName}, בעוד שבקשת המסמכים היא עבור לקוח אחר.`
      : `לא הצלחנו לוודא בבירור למי שייך ${countPhrase} ששלחת.`;
  } else {
    statement = anomaly.confident
      ? `זיהינו ש${countPhrase} ששלחת ${plural ? "שייכים" : "שייך"} ככל הנראה לחברה אחרת (${anomaly.conflictingName}).`
      : `לא הצלחנו לוודא בבירור לאיזו חברה ${countPhrase} ששלחת שייך.`;
  }

  return [statement, `האם שלחת ${plural ? "אותם" : "אותו"} בכוונה?`, "1. כן, שלחתי בכוונה", "2. לא, שלחתי בטעות"].join(
    "\n"
  );
}

// Groups documents that share the same underlying anomaly into one signature
// string — the grouping key createOrMergeIdentityAnomalyConfirmation uses to
// avoid asking a separate question per file. Ambiguous (non-confident)
// mismatches of the same kind share one signature regardless of the
// specific document, since there's no confident specific fact to
// distinguish them by anyway.
function anomalySignature(anomaly: IdentityAnomaly): string {
  if (!anomaly.confident) return `${anomaly.kind}:ambiguous`;
  return `${anomaly.kind}:${anomaly.conflictingName ?? anomaly.maskedIdNumber ?? "unknown"}`;
}

interface IdentityAnomalyPayload {
  documentIds: string[];
  anomaly: IdentityAnomaly;
  documentType: string | null;
}

async function getConfirmationReminderConfig(
  organizationId: string
): Promise<{ reminderIntervalDays: number }> {
  const db = await getDb();
  const [org] = await db
    .select({ reminderIntervalDays: organizations.reminderIntervalDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return { reminderIntervalDays: org?.reminderIntervalDays ?? 2 };
}

// Creates a new identity-anomaly pending confirmation, or — if one with the
// exact same anomaly signature is already open on this request — folds this
// document into it instead of asking a second question. Mirrors
// createUnsolicitedDocumentConfirmation in documentIntakeReview.ts (same
// trigger:"manual" + allowFreeform:true reasoning: a direct reaction to the
// document the client just sent, within the WhatsApp session window).
export async function createOrMergeIdentityAnomalyConfirmation(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string;
  anomaly: IdentityAnomaly;
  documentType: string | null;
}): Promise<void> {
  const db = await getDb();
  const signature = anomalySignature(params.anomaly);

  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, params.collectionRequestId),
        eq(pendingConfirmations.kind, "identity_anomaly" satisfies PendingConfirmationKind),
        eq(pendingConfirmations.status, "pending")
      )
    );
  const existing = openRows.find((row) => {
    const payload = row.payload as IdentityAnomalyPayload | null;
    return payload && anomalySignature(payload.anomaly) === signature;
  });

  if (existing) {
    const payload = existing.payload as IdentityAnomalyPayload;
    const documentIds = [...payload.documentIds, params.documentId];
    await db
      .update(pendingConfirmations)
      .set({
        payload: { ...payload, documentIds } satisfies IdentityAnomalyPayload,
        question: buildAnomalyQuestion(params.anomaly, documentIds.length),
      })
      .where(eq(pendingConfirmations.id, existing.id));
    console.log("[document-intake] identity anomaly merged into existing pending confirmation", {
      pendingConfirmationId: existing.id,
      collectionRequestId: params.collectionRequestId,
      documentCount: documentIds.length,
    });
    return;
  }

  const { reminderIntervalDays } = await getConfirmationReminderConfig(params.organizationId);
  const question = buildAnomalyQuestion(params.anomaly, 1);

  console.log("[document-intake] pending confirmation created (identity_anomaly)", {
    organizationId: params.organizationId,
    collectionRequestId: params.collectionRequestId,
    documentId: params.documentId,
    anomalyKind: params.anomaly.kind,
    confident: params.anomaly.confident,
  });

  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "identity_anomaly" satisfies PendingConfirmationKind,
    payload: {
      documentIds: [params.documentId],
      anomaly: params.anomaly,
      documentType: params.documentType,
    } satisfies IdentityAnomalyPayload,
    question,
    reminderIntervalDays,
    trigger: "manual",
    allowFreeform: true,
  });
}

interface ResolvedConfirmationRow {
  id: string;
  kind: string;
  status: string;
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  payload: unknown;
}

// Applies the client's yes/no answer to an identity-anomaly question to
// every document folded into it. No-op for any other confirmation kind.
export async function applyIdentityAnomalyDecision(resolved: ResolvedConfirmationRow): Promise<void> {
  if (resolved.kind !== ("identity_anomaly" satisfies PendingConfirmationKind)) return;
  const payload = resolved.payload as IdentityAnomalyPayload | null;
  const documentIds = payload?.documentIds ?? [];
  if (documentIds.length === 0) return;

  const db = await getDb();

  if (resolved.status === "declined") {
    for (const documentId of documentIds) {
      await db
        .update(documents)
        .set({
          status: "identity_anomaly_rejected",
          pendingFileContent: null,
          pendingFileMimeType: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));
    }
    await recordAuditEvent({
      organizationId: resolved.organizationId,
      eventType: "document.identity_anomaly_rejected",
      description: `הלקוח ציין שהמסמך/מסמכים נשלחו בטעות (חריגת זהות) — לא הועלו ל-Drive`,
      actorType: "client",
      clientId: resolved.clientId,
      collectionRequestId: resolved.collectionRequestId,
      metadata: { documentIds, anomalyKind: payload?.anomaly.kind },
    });
    console.log("[document-intake] identity anomaly resolved: declined, no upload", {
      documentIds,
      collectionRequestId: resolved.collectionRequestId,
    });
    return;
  }

  if (resolved.status !== "confirmed") return;

  for (const documentId of documentIds) {
    const [doc] = await db
      .select({
        fileName: documents.fileName,
        pendingFileContent: documents.pendingFileContent,
        pendingFileMimeType: documents.pendingFileMimeType,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc) continue;

    // Never marks the document as fulfilling any requirement it doesn't
    // actually match, and never changes the request's primary client —
    // uploaded as an extra document, exactly like a confirmed unsolicited
    // document, with the anomaly itself kept in payload/audit metadata as
    // the record of what the client actually confirmed.
    const targetFileName = payload?.documentType
      ? `${payload.documentType}${fileExtension(doc.fileName)}`
      : doc.fileName;
    await db
      .update(documents)
      .set({ status: "identity_anomaly_confirmed", fileName: targetFileName, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    await recordAuditEvent({
      organizationId: resolved.organizationId,
      eventType: "document.identity_anomaly_confirmed",
      description: `הלקוח אישר שהמסמך נשלח בכוונה למרות חריגת הזהות שזוהתה — נשמר כמסמך נוסף בתיקיית הלקוח`,
      actorType: "client",
      clientId: resolved.clientId,
      collectionRequestId: resolved.collectionRequestId,
      metadata: { documentId, anomalyKind: payload?.anomaly.kind, anomalyConfirmed: true },
    });

    await uploadDocumentResiliently(
      resolved.organizationId,
      resolved.clientId,
      documentId,
      targetFileName,
      resolved.collectionRequestId,
      doc.pendingFileContent ?? undefined,
      doc.pendingFileMimeType ?? undefined
    );
    console.log("[document-intake] identity anomaly resolved: confirmed, uploaded to Drive", {
      documentId,
      collectionRequestId: resolved.collectionRequestId,
    });
  }

  await sendOutboundMessage(
    resolved.organizationId,
    resolved.conversationId,
    documentIds.length > 1 ? "תודה, שמרנו את המסמכים בתיקייה שלך." : "תודה, שמרנו את המסמך בתיקייה שלך.",
    "ai",
    "manual",
    undefined,
    true
  );
}
