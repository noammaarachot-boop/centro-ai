import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, collectionRequests, conversations, documents, organizations, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import type { DocumentClassification } from "@/lib/ai/documentClassifier";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import {
  createPendingConfirmation,
  flushDueIntakeNotifications,
  type PendingConfirmationKind,
} from "@/lib/pendingConfirmations";
import { fileExtension, uploadDocumentResiliently } from "@/lib/storage/driveAdapter";
import { scheduleAfterResponse } from "@/lib/scheduleAfterResponse";
import { attemptFinishCollectionRequest, CASE_REVIEW_SILENCE_WINDOW_MS, scheduleCaseReviewRelay } from "@/lib/caseReview";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";

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

// Hebrew "X, Y ו-Z" list join — used to name the actual document types in a
// group ("תעודת זהות ודרכון") instead of a bare count, whenever every
// document in the group has a known type.
function joinHebrewList(items: string[]): string {
  if (items.length === 0) return "מסמך";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ו${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ו${items[items.length - 1]}`;
}

// Short, warm, human wording — never a formal/technical restatement of the
// request, never explains itself twice. Only the descriptive statement —
// numbered yes/no options are appended later, once this group's final
// position in a (possibly combined, possibly solo) outbound message is
// decided by flushDueIntakeNotifications (pendingConfirmations.ts).
//
// The name/company shown is always exactly what was extracted from the
// document itself (anomaly.conflictingName, sourced from the vision
// model's own extractedPersonName/extractedCompanyName — see
// detectIdentityAnomaly) — never a hardcoded or example name. When
// extraction wasn't confident enough to name anyone (anomaly.confident is
// false), the wording stays deliberately generic about the NAME — but if
// the document TYPE is still confidently known (typeLabel), that's real,
// non-hallucinated information the client can use to tell which file this
// is about, so it's always still named. Every sentence below uses "המסמך"
// (never the specific type word) as its grammatical subject, with the type
// itself only ever shown on its own "📄 {type}" label line — Hebrew gender
// agreement (הוא/היא, שייך/שייכת) would otherwise have to vary per
// arbitrary type string; "המסמך" sidesteps that entirely.
//
// Used only when there's no matchedRequirementName (see buildReplaceQuestion
// below for that case) — the original, unchanged "did you mean to send
// this?" wording.
function buildGenericQuestion(anomaly: IdentityAnomaly, documentTypes: Array<string | null>): string {
  const count = documentTypes.length;
  const plural = count > 1;
  const knownTypes = documentTypes.filter((t): t is string => !!t);
  const allTypesKnown = knownTypes.length === count;
  const typeLabel = allTypesKnown ? joinHebrewList(knownTypes) : plural ? `${count} מסמכים` : "מסמך";
  const askLine = plural ? "האם שלחת אותם בכוונה?" : "האם שלחת אותו בכוונה?";

  if (anomaly.kind === "id_mismatch") {
    return `📄 ${typeLabel}\nמספר תעודת הזהות (מסתיים ב-${anomaly.maskedIdNumber}) שונה מהמסמכים הקודמים שקיבלתי.\n\n${askLine}`;
  }

  if (!anomaly.confident) {
    if (allTypesKnown) {
      return `📄 ${typeLabel}\nנראה ש${plural ? "המסמכים שייכים" : "המסמך שייך"} לאדם אחר, אך לא הצלחתי לקרוא את השם בבירור.\n\n${askLine}`;
    }
    return plural
      ? `מצאתי מסמכים שנראה שהם שייכים לאדם אחר.\n${askLine}`
      : `מצאתי מסמך שנראה שהוא שייך לאדם אחר.\n${askLine}`;
  }

  if (anomaly.kind === "company_mismatch") {
    return `📄 ${typeLabel}\n${plural ? "נראה ששייכים" : "נראה ששייך"} לחברה אחרת (${anomaly.conflictingName}).\n\n${askLine}`;
  }

  return `📄 ${typeLabel}\n${plural ? "המסמכים הם" : "המסמך הוא"} על שם ${anomaly.conflictingName}, והשם אינו תואם לבעל הבקשה.\n\n${askLine}`;
}

// The explicit "does this replace X?" question — used whenever the
// document's TYPE was already confidently matched to a specific open
// requirement before this anomaly overrode it (conversationActions.ts).
// Every document in a group is guaranteed to share the same
// matchedRequirementName (see anomalySignature below), so this always
// asks about exactly one requirement.
//
// Deliberately spelled out in full, two-sentence form (not the terser
// "📄 type\n...\n\naskLine" shape buildGenericQuestion uses) so the client
// understands precisely what "כן" commits to — a direct product
// requirement: naming the document's own type+name, then explicitly
// asking whether it was sent INSTEAD OF the original requirement, naming
// the client. matchedRequirementName is repeated as-is (never grammatically
// inflected, e.g. no attempt at "תעודת הזהות" or "שנדרשה") — an arbitrary
// office-authored requirement name has no reliable way to auto-detect
// Hebrew grammatical gender/construct-state for correct agreement, and a
// plain repeated noun reads perfectly clearly either way.
//
// extractedNames: the raw name/company actually found ON each document in
// the group (not anomaly.conflictingName, which for id_mismatch names a
// SIBLING document's person, not this one's own) — the first non-null
// entry is used; a genuinely mixed-name group is exceedingly rare given
// how narrowly groups are scoped now (see anomalySignature).
function buildReplaceQuestion(
  anomaly: IdentityAnomaly,
  documentTypes: Array<string | null>,
  extractedNames: Array<string | null>,
  matchedRequirementName: string,
  clientName: string
): string {
  const count = documentTypes.length;
  const plural = count > 1;
  const knownTypes = documentTypes.filter((t): t is string => !!t);
  const allTypesKnown = knownTypes.length === count;
  const typeLabel = allTypesKnown ? joinHebrewList(knownTypes) : plural ? `${count} מסמכים` : "מסמך";
  const name = extractedNames.find((n): n is string => !!n) ?? null;
  const subject = plural ? "המסמכים שהתקבלו הם" : "המסמך שהתקבל הוא";
  const askLine = plural
    ? `האם הם נשלחו במקום ${matchedRequirementName} של ${clientName}?`
    : `האם הוא נשלח במקום ${matchedRequirementName} של ${clientName}?`;

  if (anomaly.kind === "id_mismatch") {
    const nameClause = name ? ` על שם ${name},` : "";
    return `${subject} ${typeLabel}${nameClause} עם מספר תעודת זהות (מסתיים ב-${anomaly.maskedIdNumber}) שונה ממה שקיבלתי עד כה.\n\n${askLine}`;
  }

  if (!anomaly.confident) {
    return `${subject} ${typeLabel}, שנראה שאינו על שם ${clientName}, אך לא הצלחתי לקרוא בבירור על שם מי הוא.\n\n${askLine}`;
  }

  if (anomaly.kind === "company_mismatch") {
    const nameClause = name ? ` על שם החברה ${name}` : "";
    return `${subject} ${typeLabel}${nameClause}.\n\n${askLine}`;
  }

  const nameClause = name ? ` על שם ${name}` : `, שאינו על שם ${clientName}`;
  return `${subject} ${typeLabel}${nameClause}.\n\n${askLine}`;
}

function buildAnomalyQuestion(
  anomaly: IdentityAnomaly,
  documentTypes: Array<string | null>,
  extractedNames: Array<string | null>,
  matchedRequirementName: string | null,
  clientName: string
): string {
  return matchedRequirementName
    ? buildReplaceQuestion(anomaly, documentTypes, extractedNames, matchedRequirementName, clientName)
    : buildGenericQuestion(anomaly, documentTypes);
}

// Groups documents that share the same underlying anomaly AND the same
// candidate requirement into one signature string — the grouping key
// createOrMergeIdentityAnomalyConfirmation uses to avoid asking a separate
// question per file. Ambiguous (non-confident) mismatches of the same kind
// share one signature regardless of the specific document, since there's no
// confident specific fact to distinguish them by anyway. Including
// matchedRequirementId is deliberate: two documents that happen to share an
// anomaly but target DIFFERENT requirements (or one targets none) are
// asking two genuinely different "does this replace X?" questions and must
// never be merged into one — every document in a resulting group is
// guaranteed to share exactly one matchedRequirementName (or none).
function anomalySignature(anomaly: IdentityAnomaly, matchedRequirementId: string | null): string {
  const base = !anomaly.confident ? `${anomaly.kind}:ambiguous` : `${anomaly.kind}:${anomaly.conflictingName ?? anomaly.maskedIdNumber ?? "unknown"}`;
  return `${base}::req:${matchedRequirementId ?? "none"}`;
}

interface IdentityAnomalyPayload {
  // matchedRequirementId/matchedRequirementName: the open requirement
  // resolveDocumentIntakeOutcome had already confidently matched before
  // this specific anomaly overrode it (conversationActions.ts) — null
  // whenever there wasn't one (an unsolicited-but-anomalous document, or
  // the fallback never cleared the confidence bar). Every document in a
  // group shares the same values (see anomalySignature above), but still
  // carried per-document for a simple, uniform shape.
  documents: Array<{
    id: string;
    documentType: string | null;
    matchedRequirementId: string | null;
    matchedRequirementName: string | null;
    // The raw name/company actually extracted FROM this document — see
    // buildReplaceQuestion's own doc comment for why this is kept
    // separate from anomaly.conflictingName.
    extractedPersonName: string | null;
    extractedCompanyName: string | null;
  }>;
  anomaly: IdentityAnomaly;
  // The request's own client — same for the whole request, not per-document.
  clientName: string;
}

async function getGroupingWindowSeconds(organizationId: string): Promise<number> {
  const db = await getDb();
  const [org] = await db
    .select({ documentGroupingWindowSeconds: organizations.documentGroupingWindowSeconds })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return org?.documentGroupingWindowSeconds ?? 15;
}

// Creates a new identity-anomaly pending confirmation, or — if one with the
// exact same anomaly signature is already open (still unnotified) on this
// request — folds this document into it instead of asking a second
// question. Batched mode (notifyAfter): the actual WhatsApp send is held
// until flushDueIntakeNotifications (pendingConfirmations.ts) fires, so
// several documents/anomalies arriving in a short burst reach the client as
// one combined message — see that module's own doc comment for why.
export async function createOrMergeIdentityAnomalyConfirmation(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string;
  anomaly: IdentityAnomaly;
  documentType: string | null;
  matchedRequirementId: string | null;
  extractedPersonName: string | null;
  extractedCompanyName: string | null;
  clientName: string;
}): Promise<void> {
  const db = await getDb();
  const signature = anomalySignature(params.anomaly, params.matchedRequirementId);

  let matchedRequirementName: string | null = null;
  if (params.matchedRequirementId) {
    const [requirement] = await db
      .select({ name: collectionRequestRequirements.name })
      .from(collectionRequestRequirements)
      .where(eq(collectionRequestRequirements.id, params.matchedRequirementId))
      .limit(1);
    matchedRequirementName = requirement?.name ?? null;
  }

  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, params.collectionRequestId),
        eq(pendingConfirmations.kind, "identity_anomaly" satisfies PendingConfirmationKind),
        eq(pendingConfirmations.status, "pending"),
        isNull(pendingConfirmations.notifiedAt)
      )
    );
  const existing = openRows.find((row) => {
    const payload = row.payload as IdentityAnomalyPayload | null;
    return (
      payload &&
      anomalySignature(payload.anomaly, payload.documents[0]?.matchedRequirementId ?? null) === signature
    );
  });

  if (existing) {
    const payload = existing.payload as IdentityAnomalyPayload;
    const documentsInGroup = [
      ...payload.documents,
      {
        id: params.documentId,
        documentType: params.documentType,
        matchedRequirementId: params.matchedRequirementId,
        matchedRequirementName,
        extractedPersonName: params.extractedPersonName,
        extractedCompanyName: params.extractedCompanyName,
      },
    ];
    await db
      .update(pendingConfirmations)
      .set({
        payload: { ...payload, documents: documentsInGroup } satisfies IdentityAnomalyPayload,
        question: buildAnomalyQuestion(
          params.anomaly,
          documentsInGroup.map((d) => d.documentType),
          documentsInGroup.map((d) => d.extractedPersonName ?? d.extractedCompanyName),
          matchedRequirementName,
          params.clientName
        ),
      })
      .where(eq(pendingConfirmations.id, existing.id));
    console.log("[document-intake] identity anomaly merged into existing pending confirmation", {
      pendingConfirmationId: existing.id,
      collectionRequestId: params.collectionRequestId,
      documentCount: documentsInGroup.length,
    });
    return;
  }

  console.log("[document-intake] pending confirmation created (identity_anomaly)", {
    organizationId: params.organizationId,
    collectionRequestId: params.collectionRequestId,
    documentId: params.documentId,
    anomalyKind: params.anomaly.kind,
    confident: params.anomaly.confident,
    matchedRequirementId: params.matchedRequirementId,
  });

  const groupingWindowSeconds = await getGroupingWindowSeconds(params.organizationId);
  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "identity_anomaly" satisfies PendingConfirmationKind,
    payload: {
      documents: [
        {
          id: params.documentId,
          documentType: params.documentType,
          matchedRequirementId: params.matchedRequirementId,
          matchedRequirementName,
          extractedPersonName: params.extractedPersonName,
          extractedCompanyName: params.extractedCompanyName,
        },
      ],
      anomaly: params.anomaly,
      clientName: params.clientName,
    } satisfies IdentityAnomalyPayload,
    question: buildAnomalyQuestion(
      params.anomaly,
      [params.documentType],
      [params.extractedPersonName ?? params.extractedCompanyName],
      matchedRequirementName,
      params.clientName
    ),
    notifyAfter: new Date(Date.now() + groupingWindowSeconds * 1000),
  });

  // The actual send trigger — see flushDueIntakeNotifications's own doc
  // comment (pendingConfirmations.ts) for why the lazy "next document"
  // check and the cron backstop alone were not enough. Scheduled only
  // here, on the group's creation — a document that merges into this
  // group later doesn't need its own timer, this one still covers it.
  scheduleAfterResponse(async () => {
    await new Promise((resolve) => setTimeout(resolve, groupingWindowSeconds * 1000));
    await flushDueIntakeNotifications(params.organizationId, params.collectionRequestId);
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

// Uploads a document as an unassociated "extra" — never marks it as
// fulfilling any requirement, never changes the request's primary client.
// Shared by every path that ends with "kept, but not as a replacement":
// the generic "sent on purpose" confirm, the explicit "no, doesn't replace
// X" decline, and the safety fallback when a requirement it was cleared to
// replace turned out to no longer be open. Each document keeps its own
// type-based name (an ID card and a passport in the same group must not
// both become the same filename).
async function saveIdentityAnomalyDocumentAsExtra(params: {
  db: Awaited<ReturnType<typeof getDb>>;
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string;
  documentType: string | null;
  anomalyKind: IdentityAnomaly["kind"] | undefined;
  fileName: string;
  pendingFileContent: Buffer | null;
  pendingFileMimeType: string | null;
  auditDescription: string;
}): Promise<void> {
  const targetFileName = params.documentType ? `${params.documentType}${fileExtension(params.fileName)}` : params.fileName;
  await params.db
    .update(documents)
    .set({ status: "identity_anomaly_confirmed", fileName: targetFileName, updatedAt: new Date() })
    .where(eq(documents.id, params.documentId));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "document.identity_anomaly_confirmed",
    description: params.auditDescription,
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { documentId: params.documentId, anomalyKind: params.anomalyKind, anomalyConfirmed: true },
  });

  await uploadDocumentResiliently(
    params.organizationId,
    params.clientId,
    params.documentId,
    targetFileName,
    params.collectionRequestId,
    params.pendingFileContent ?? undefined,
    params.pendingFileMimeType ?? undefined
  );
  console.log("[document-intake] identity anomaly resolved: kept as extra, uploaded to Drive", {
    documentId: params.documentId,
    collectionRequestId: params.collectionRequestId,
  });
}

// Applies the client's answer to an identity-anomaly question to every
// document folded into it. No-op for any other confirmation kind.
//
// Two distinct modes, decided per document by whether it was already
// confidently matched to a specific open requirement before the identity
// check overrode that outcome (matchedRequirementId — see
// conversationActions.ts). Every document in one group shares the same
// value here (anomalySignature only merges documents that do), so this
// reads simply as "which question was actually asked":
//
// - Matched a requirement → the question was "does this REPLACE X?"
//   (buildAnomalyQuestion). The client's own explicit answer is the sole
//   authority on whether an identity-mismatched document satisfies the
//   original requirement — never a confidence heuristic, and this applies
//   uniformly regardless of anomaly kind (name/company/ID mismatch) or
//   whether the mismatch was confident or ambiguous. "כן" attaches it and
//   closes that one requirement; "לא" still keeps the document, just as an
//   unassociated extra — the client is not discarding it, only declining
//   to treat it as the replacement.
// - No matched requirement → the original, unchanged question ("did you
//   mean to send this?"). "כן" keeps it as an extra; "לא" discards it
//   entirely (never uploaded) — this half is untouched by this feature.
export async function applyIdentityAnomalyDecision(resolved: ResolvedConfirmationRow): Promise<void> {
  if (resolved.kind !== ("identity_anomaly" satisfies PendingConfirmationKind)) return;
  const payload = resolved.payload as IdentityAnomalyPayload | null;
  const documentsInGroup = payload?.documents ?? [];
  if (documentsInGroup.length === 0) return;
  if (resolved.status !== "confirmed" && resolved.status !== "declined") return;

  const db = await getDb();
  const confirmed = resolved.status === "confirmed";
  let anyAttachedToRequirement = false;
  let anyKeptAsExtra = false;

  for (const { id: documentId, documentType, matchedRequirementId, matchedRequirementName } of documentsInGroup) {
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

    if (matchedRequirementId && confirmed) {
      // "כן, מחליף את X" — re-check, never trust the original snapshot:
      // something else may have satisfied this requirement while the
      // confirmation sat waiting for an answer (e.g. the client separately
      // sent the correct document), in which case forcing this one onto
      // it would be wrong. Never a fresh guess at match confidence — only
      // ever reuses the exact decision resolveDocumentIntakeOutcome
      // already made at the same bar every ordinary auto-approval
      // requires.
      const [requirement] = await db
        .select({
          id: collectionRequestRequirements.id,
          requiredCount: collectionRequestRequirements.requiredCount,
          semanticSpec: collectionRequestRequirements.semanticSpec,
          exceptionStatus: collectionRequestRequirements.exceptionStatus,
        })
        .from(collectionRequestRequirements)
        .where(eq(collectionRequestRequirements.id, matchedRequirementId))
        .limit(1);
      let stillOpen = false;
      if (requirement) {
        const approvedSiblings = await db
          .select({
            extractedPeriodLabel: documents.extractedPeriodLabel,
            extractedPersonName: documents.extractedPersonName,
            continuationOfDocumentId: documents.continuationOfDocumentId,
          })
          .from(documents)
          .where(and(eq(documents.requirementId, matchedRequirementId), eq(documents.status, "approved")));
        const satisfactionDocs = approvedSiblings
          .filter((d) => !d.continuationOfDocumentId)
          .map((d) => ({ periodLabel: d.extractedPeriodLabel, personName: d.extractedPersonName }));
        stillOpen = !computeRequirementSatisfaction(requirement, satisfactionDocs).satisfied;
      }

      if (stillOpen) {
        // Genuinely fulfills the requirement the client just explicitly
        // confirmed it replaces — counts as received, not just kept for
        // transparency. Filename is left to uploadDocument's own
        // requirementId-based renaming (same as every ordinary approved
        // document), not the documentType-based name the "extra" path uses.
        await db
          .update(documents)
          .set({ requirementId: matchedRequirementId, status: "approved", updatedAt: new Date() })
          .where(eq(documents.id, documentId));

        await recordAuditEvent({
          organizationId: resolved.organizationId,
          eventType: "document.identity_anomaly_confirmed",
          description: `הלקוח אישר במפורש שהמסמך מחליף את הדרישה "${matchedRequirementName ?? ""}" למרות חריגת הזהות שזוהתה — נחשב כמסמך שהתקבל`,
          actorType: "client",
          clientId: resolved.clientId,
          collectionRequestId: resolved.collectionRequestId,
          metadata: { documentId, anomalyKind: payload?.anomaly.kind, anomalyConfirmed: true, requirementId: matchedRequirementId },
        });

        await uploadDocumentResiliently(
          resolved.organizationId,
          resolved.clientId,
          documentId,
          doc.fileName,
          resolved.collectionRequestId,
          doc.pendingFileContent ?? undefined,
          doc.pendingFileMimeType ?? undefined
        );
        console.log("[document-intake] identity anomaly resolved: confirmed replacement, attached to requirement, uploaded to Drive", {
          documentId,
          requirementId: matchedRequirementId,
          collectionRequestId: resolved.collectionRequestId,
        });
        anyAttachedToRequirement = true;
        continue;
      }

      // The requirement it was meant to replace is no longer open — never
      // force it onto a requirement that's already satisfied by something
      // else; falls back to the same "kept as extra" treatment as a "לא".
      await saveIdentityAnomalyDocumentAsExtra({
        db,
        organizationId: resolved.organizationId,
        clientId: resolved.clientId,
        collectionRequestId: resolved.collectionRequestId,
        documentId,
        documentType,
        anomalyKind: payload?.anomaly.kind,
        fileName: doc.fileName,
        pendingFileContent: doc.pendingFileContent,
        pendingFileMimeType: doc.pendingFileMimeType,
        auditDescription: `הלקוח אישר שהמסמך מחליף את "${matchedRequirementName ?? ""}", אך הדרישה כבר הושלמה בינתיים — נשמר כמסמך נוסף בתיקיית הלקוח`,
      });
      anyKeptAsExtra = true;
      continue;
    }

    if (matchedRequirementId && !confirmed) {
      // "לא, לא מחליף את X" — the document is still real and still kept,
      // the client is only declining to treat it as the replacement. The
      // original requirement stays exactly as open as it was.
      await saveIdentityAnomalyDocumentAsExtra({
        db,
        organizationId: resolved.organizationId,
        clientId: resolved.clientId,
        collectionRequestId: resolved.collectionRequestId,
        documentId,
        documentType,
        anomalyKind: payload?.anomaly.kind,
        fileName: doc.fileName,
        pendingFileContent: doc.pendingFileContent,
        pendingFileMimeType: doc.pendingFileMimeType,
        auditDescription: `הלקוח ציין שהמסמך אינו מחליף את הדרישה "${matchedRequirementName ?? ""}" — נשמר כמסמך נוסף בתיקיית הלקוח`,
      });
      anyKeptAsExtra = true;
      continue;
    }

    if (confirmed) {
      // No matched requirement at all — the original, unchanged "did you
      // mean to send this?" flow: "כן" keeps it as an extra.
      await saveIdentityAnomalyDocumentAsExtra({
        db,
        organizationId: resolved.organizationId,
        clientId: resolved.clientId,
        collectionRequestId: resolved.collectionRequestId,
        documentId,
        documentType,
        anomalyKind: payload?.anomaly.kind,
        fileName: doc.fileName,
        pendingFileContent: doc.pendingFileContent,
        pendingFileMimeType: doc.pendingFileMimeType,
        auditDescription: `הלקוח אישר שהמסמך נשלח בכוונה למרות חריגת הזהות שזוהתה — נשמר כמסמך נוסף בתיקיית הלקוח`,
      });
      anyKeptAsExtra = true;
      continue;
    }

    // No matched requirement, declined — the original, unchanged behavior:
    // never uploaded, pending bytes cleared, nothing left behind.
    await db
      .update(documents)
      .set({
        status: "identity_anomaly_rejected",
        pendingFileContent: null,
        pendingFileMimeType: null,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));
    await recordAuditEvent({
      organizationId: resolved.organizationId,
      eventType: "document.identity_anomaly_rejected",
      description: `הלקוח ציין שהמסמך נשלח בטעות (חריגת זהות) — לא הועלה ל-Drive`,
      actorType: "client",
      clientId: resolved.clientId,
      collectionRequestId: resolved.collectionRequestId,
      metadata: { documentId, anomalyKind: payload?.anomaly.kind },
    });
    console.log("[document-intake] identity anomaly resolved: declined, no upload", {
      documentId,
      collectionRequestId: resolved.collectionRequestId,
    });
  }

  // A single ack for the whole group — every real document in a group
  // shares the same matchedRequirementId (anomalySignature guarantees
  // this), so in practice every document just took the same branch above;
  // the wording only needs to distinguish the three possible outcomes.
  const ackMessage = anyAttachedToRequirement
    ? "תודה! שמרתי את המסמך."
    : anyKeptAsExtra
      ? confirmed
        ? "תודה! שמרתי את המסמך."
        : "בסדר, שמרתי את המסמך כמסמך נוסף."
      : "בסדר, המסמך לא ייכלל.";
  await sendOutboundMessage(resolved.organizationId, resolved.conversationId, ackMessage, "ai", "manual", undefined, true);

  // The silence window is restarted unconditionally below — real activity
  // (a reply) just happened regardless of which outcome above it was,
  // matching unsolicited_document's own decline branch exactly even when
  // the document was fully discarded (no matched requirement, declined).
  await db
    .update(conversations)
    .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
    .where(eq(conversations.id, resolved.conversationId));
  scheduleAfterResponse(() =>
    scheduleCaseReviewRelay({
      organizationId: resolved.organizationId,
      conversationId: resolved.conversationId,
      collectionRequestId: resolved.collectionRequestId,
      clientId: resolved.clientId,
    })
  );

  // At least one document in this group just became a genuine
  // requirement-satisfying "approved" document (not just an extra) — this
  // reply might be exactly what completes the whole request. Check
  // immediately instead of waiting for the 2-minute window above to elapse,
  // the same way an ordinary approved document does
  // (processInboundAttachment, conversationActions.ts). checkCompletionGate
  // is consulted first, same as there, so a request that's genuinely not
  // yet done never gets an unwanted "still missing X" message from this
  // check alone — the arm-timer above already covers that ordinary case.
  if (anyAttachedToRequirement) {
    // A post-completion extension in progress owns its own "are you done
    // adding documents?" flow (src/lib/requestExtension.ts) — never
    // attempt to complete the request from here while one is active, same
    // as the ordinary approved-document path (processInboundAttachment)
    // guards against it.
    const [request] = await db
      .select({ extensionActive: collectionRequests.extensionActive })
      .from(collectionRequests)
      .where(eq(collectionRequests.id, resolved.collectionRequestId))
      .limit(1);
    if (!request?.extensionActive) {
      const gateError = await checkCompletionGate(resolved.collectionRequestId);
      if (gateError === null) {
        await attemptFinishCollectionRequest({
          organizationId: resolved.organizationId,
          collectionRequestId: resolved.collectionRequestId,
          conversationId: resolved.conversationId,
          clientId: resolved.clientId,
          actorType: "client",
        });
      }
    }
  }
}
