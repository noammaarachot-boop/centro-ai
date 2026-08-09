/**
 * Ch.9/Ch.11 document classification & matching, and (Milestone 3) Ch.6's
 * Decision Hierarchy generalized to a second real domain — mocked at the
 * matching layer (no OCR/LLM provider is configured for this pilot; that
 * requires real API credentials this environment doesn't have). Real OCR
 * implementation runs OCR then an LLM classification call; this uses
 * filename validation and keyword-token overlap against the candidate
 * requirement names as a deterministic stand-in with the exact same
 * interface (supported / readable / matched requirement / confidence), so
 * swapping in a real provider later only touches this file.
 *
 * classifyDocumentWithLearning() is the full 4-layer pipeline (Learned
 * Knowledge -> Business Rules -> AI -> Human Review), mirroring
 * src/lib/ai/businessTypeClassifier.ts's structure exactly.
 * classifyDocument() itself remains the plain Business-Rules-only
 * heuristic — kept as its own exported function since it has no
 * dependency on a client's learning history and is simpler to reason
 * about and call directly wherever that's all that's needed.
 */

import { classifyDocumentViaVisionAI } from "./documentVisionClassifier";
import type { DocumentClassificationCandidate } from "./documentClassifierTypes";

export type { DocumentClassificationCandidate } from "./documentClassifierTypes";

export const SUPPORTED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "heic"];

// Confidence at/above this auto-approves (PR-002 "AI Assists — Humans
// Decide" still applies below it: anything less certain lands in
// needs_review for a person to resolve, per BR-11.3).
export const AUTO_APPROVE_CONFIDENCE = 0.6;

// A learned match (this exact client's own confirmed history) is the most
// specific signal available — always scored above AUTO_APPROVE_CONFIDENCE,
// same principle as a business-type learned synonym always outranking a
// generic dictionary hit (Architecture Ch.6).
const LEARNED_MATCH_CONFIDENCE = 0.95;

// How similar a new filename needs to be to a previously-confirmed one
// (Jaccard token overlap) to count as "the same recurring document type"
// for this client. Lower than isFuzzyDuplicate's 0.7 (which compares two
// uploads of what's likely the *same* file, e.g. a renamed re-upload) —
// this compares *different* files of the same conceptual document across
// different months (e.g. "bank_statement_january.pdf" vs
// "bank_statement_february.pdf"), which naturally share fewer tokens.
export const LEARNED_PATTERN_MATCH_THRESHOLD = 0.5;

export interface DocumentClassification {
  supported: boolean;
  readable: boolean;
  matchedRequirementId: string | null;
  confidence: number;
  // Populated only when the AI vision layer actually returned a usable
  // result (real file bytes were available and the model responded) — lets
  // resolveDocumentIntakeOutcome (src/lib/documentIntakeReview.ts)
  // distinguish "AI confidently identified this as something else" (a
  // document that doesn't need a human at all, just the client's
  // confirmation) from "nothing could determine what this is" (genuinely
  // needs a person, or at least the client's own description, eventually).
  // Never set by the deterministic/learned layers, which have no concept
  // of "identified but not needed."
  aiRan?: boolean;
  aiIdentified?: boolean;
  aiDocumentType?: string | null;
  // Smart identity/consistency verification (documentIdentityVerification.ts)
  // — carried through regardless of whether this classification matched a
  // requirement, since even a document of the right type can belong to the
  // wrong person. Populated only when aiRan is true and the model actually
  // extracted something; see documentVisionClassifier.ts's own doc comment.
  extractedPersonName?: string | null;
  extractedIdNumber?: string | null;
  extractedCompanyName?: string | null;
  identityExtractionConfidence?: number;
  // Quantity-aware requirement engine (src/lib/documentQuantity.ts) — same
  // aiRan-gated carry-through as the identity fields above.
  extractedPeriodLabel?: string | null;
  periodExtractionConfidence?: number;
  // Multi-signal multi-page detection (src/lib/documentContinuation.ts) —
  // same aiRan-gated carry-through as the fields above.
  extractedReferenceNumber?: string | null;
  pageNumberCurrent?: number | null;
  pageNumberTotal?: number | null;
  // Immediate problematic-document handling (src/lib/documentIntakeReview.ts's
  // resolveDocumentIntakeOutcome) — same aiRan-gated carry-through as the
  // fields above; see documentVisionClassifier.ts's own doc comments for
  // what each means and the anti-hallucination guardrails on them.
  readabilityIssue?: "blurry" | "cropped_or_incomplete" | "too_dark_or_low_quality" | "damaged" | "wrong_orientation" | "other" | null;
  readabilityIssueDetail?: string | null;
  suspectedDocumentType?: string | null;
  clientMessageIfProblematic?: string | null;
}

export interface LearnedDocumentPattern {
  sourceRequirementId: string;
  fileName: string;
}

function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9א-ת]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function stripExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
}

// Compares two *filenames* — always on their base name, extension
// stripped first. Two files sharing an extension (the overwhelmingly
// common case — most of a client's documents are PDFs) would otherwise
// share a "pdf" token for free, artificially inflating the similarity of
// two otherwise-unrelated files. Found via a real end-to-end test during
// Milestone 5's verification: an unrelated second document was
// auto-matched against a single prior correction purely because both
// happened to be PDFs.
function jaccardTokenSimilarity(fileNameA: string, fileNameB: string): number {
  const tokensA = new Set(normalize(stripExtension(fileNameA)));
  const tokensB = new Set(normalize(stripExtension(fileNameB)));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

interface FileGateFailure {
  supported: boolean;
  readable: boolean;
}

// FR-11.2/FR-11.3: unsupported types and unreadable scans are rejected
// before any matching is attempted, regardless of which matching layer
// would otherwise run — shared by classifyDocument and
// classifyDocumentWithLearning so this gate is implemented exactly once.
function checkFileGate(fileName: string): FileGateFailure | null {
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    return { supported: false, readable: false };
  }
  // FR-11.3 stand-in: a real OCR call fails on unreadable scans; here, a
  // suspiciously short base name plays that role deterministically.
  const baseName = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  if (baseName.trim().length < 2) {
    return { supported: true, readable: false };
  }
  return null;
}

// The raw token-overlap scorer, with no notion of "is this a filename" —
// shared by classifyDocument (which gates on a real file extension first,
// below) and documentIntakeReview.ts's clarification-reply matching (a
// client's own short free-text answer, e.g. "תעודת זהות שלי", which has no
// extension to gate on and was never meant to be treated like one).
export function matchTextToCandidates(
  text: string,
  candidates: Array<{ id: string; name: string }>
): { id: string; score: number } | null {
  const fileTokens = normalize(text);
  let best: { id: string; score: number } | null = null;

  for (const candidate of candidates) {
    const candidateTokens = normalize(candidate.name);
    if (candidateTokens.length === 0) continue;
    const overlap = candidateTokens.filter((token) =>
      fileTokens.some((fileToken) => fileToken.includes(token) || token.includes(fileToken))
    ).length;
    const score = overlap / candidateTokens.length;
    if (score > 0 && (!best || score > best.score)) {
      best = { id: candidate.id, score };
    }
  }

  return best;
}

// The plain deterministic heuristic — Ch.6's "Business Rules" layer for
// documents: universal, the same for every organization, no learning
// involved. Exported directly for any caller that has no client-specific
// learning history to check first.
export async function classifyDocument(
  fileName: string,
  candidates: Array<{ id: string; name: string }>
): Promise<DocumentClassification> {
  const gateFailure = checkFileGate(fileName);
  if (gateFailure) {
    return { ...gateFailure, matchedRequirementId: null, confidence: 0 };
  }

  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  const best = matchTextToCandidates(baseName, candidates);

  return {
    supported: true,
    readable: true,
    matchedRequirementId: best?.id ?? null,
    confidence: best?.score ?? 0,
  };
}

// Ch.6 layer 1 (Learned Knowledge) for documents — checks this specific
// client's own previously-confirmed corrections before anything generic.
// Not an exact-text lookup (unlike business-type synonyms): filenames vary
// too much month to month, so this is a fuzzy best-match against every
// pattern this client has taught Centro, accepted only above
// LEARNED_PATTERN_MATCH_THRESHOLD.
export function matchLearnedPattern(
  fileName: string,
  learnedPatterns: LearnedDocumentPattern[]
): { sourceRequirementId: string; confidence: number } | null {
  let best: { sourceRequirementId: string; score: number } | null = null;
  for (const pattern of learnedPatterns) {
    const score = jaccardTokenSimilarity(fileName, pattern.fileName);
    if (score >= LEARNED_PATTERN_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { sourceRequirementId: pattern.sourceRequirementId, score };
    }
  }
  return best ? { sourceRequirementId: best.sourceRequirementId, confidence: LEARNED_MATCH_CONFIDENCE } : null;
}

// Real file content to classify against, when the caller has it — only
// real inbound WhatsApp attachments (src/app/api/webhooks/whatsapp/route.ts)
// and manual uploads with an actual file do. The DevTools simulator and any
// other filename-only path omit this, and layer 3 below stays a no-op for
// them exactly as before (there's nothing to show a vision model).
export interface ClassifiableFileContent {
  bytes: Buffer;
  mimeType: string;
}

// Ch.6 layer 3 (AI) — reached only once Learned Knowledge and the
// deterministic filename heuristic have both failed to confidently match.
// Delegates to documentVisionClassifier.ts, which reads the actual file
// content via a configured multimodal provider — this is the only layer
// that can work on a WhatsApp-inbound photo, since Meta never supplies a
// real filename for one (the deterministic heuristic above is filename-only
// and always scores 0 against a generated name like "image_<wamid>.jpg").
// With no fileContent (filename-only paths) this stays the documented
// no-op it always was.
interface AiClassificationResult {
  matchedRequirementId: string | null;
  confidence: number;
  aiIdentified: boolean;
  aiDocumentType: string | null;
  extractedPersonName: string | null;
  extractedIdNumber: string | null;
  extractedCompanyName: string | null;
  identityExtractionConfidence: number;
  extractedPeriodLabel: string | null;
  periodExtractionConfidence: number;
  extractedReferenceNumber: string | null;
  pageNumberCurrent: number | null;
  pageNumberTotal: number | null;
  readabilityIssue: "blurry" | "cropped_or_incomplete" | "too_dark_or_low_quality" | "damaged" | "wrong_orientation" | "other" | null;
  readabilityIssueDetail: string | null;
  suspectedDocumentType: string | null;
  clientMessageIfProblematic: string | null;
}

async function classifyDocumentViaAI(
  candidates: DocumentClassificationCandidate[],
  fileContent: ClassifiableFileContent | undefined
): Promise<AiClassificationResult | null> {
  if (!fileContent) return null;
  const result = await classifyDocumentViaVisionAI(fileContent.bytes, fileContent.mimeType, candidates);
  if (!result) return null;
  return {
    matchedRequirementId: result.matchedRequirementId,
    confidence: result.matchConfidence,
    aiIdentified: result.identified,
    aiDocumentType: result.documentType,
    extractedPersonName: result.extractedPersonName,
    extractedIdNumber: result.extractedIdNumber,
    extractedCompanyName: result.extractedCompanyName,
    identityExtractionConfidence: result.identityExtractionConfidence,
    extractedPeriodLabel: result.documentPeriodLabel,
    periodExtractionConfidence: result.periodExtractionConfidence,
    extractedReferenceNumber: result.documentReferenceNumber,
    pageNumberCurrent: result.pageNumberCurrent,
    pageNumberTotal: result.pageNumberTotal,
    readabilityIssue: result.readabilityIssue,
    readabilityIssueDetail: result.readabilityIssueDetail,
    suspectedDocumentType: result.suspectedDocumentType,
    clientMessageIfProblematic: result.clientMessageIfProblematic,
  };
}

// The full 4-layer pipeline: Learned Knowledge -> Business Rules -> AI ->
// (implicitly) Human Review, via the same needs_review fallthrough that
// already existed. Layer 4 is never returned from here directly — an
// unmatched result routes to needs_review exactly as it always has, in
// the caller (src/app/(app)/collections/conversationActions.ts).
export async function classifyDocumentWithLearning(
  fileName: string,
  candidates: DocumentClassificationCandidate[],
  learnedPatterns: LearnedDocumentPattern[],
  fileContent?: ClassifiableFileContent
): Promise<DocumentClassification> {
  const gateFailure = checkFileGate(fileName);
  if (gateFailure) {
    return { ...gateFailure, matchedRequirementId: null, confidence: 0 };
  }

  // Real production incident: a test/sample file literally named
  // "..._תעודת_זהות_..." scored a perfect filename-overlap match against
  // the "תעודת זהות" requirement and was auto-approved WITHOUT the vision
  // model ever running — extractedPersonName/extractedIdNumber came back
  // null because classifyDocumentViaAI was never even called, not because
  // it looked and found nothing. "לא לנחש לפי שם הקובץ בלבד" (never guess
  // from the filename alone): a filename-only match (learned pattern or
  // the deterministic heuristic below) is only ever allowed to skip real
  // content verification when there is NO real content to verify against
  // in the first place (fileContent undefined — the DevTools simulator
  // and any other filename-only path). Every genuine inbound WhatsApp
  // attachment always has fileContent, so this can never again finalize
  // an "approved" outcome purely from a filename resembling a requirement
  // name — classifyDocumentViaAI below always gets the chance to actually
  // look at the file, confirm legibility, and (via
  // documentIdentityVerification.ts) confirm whose document it actually
  // is, before anything can count as received.
  const learnedMatch = matchLearnedPattern(fileName, learnedPatterns);
  if (learnedMatch && !fileContent) {
    const candidate = candidates.find(
      (c) => c.sourceRequirementId === learnedMatch.sourceRequirementId
    );
    if (candidate) {
      return {
        supported: true,
        readable: true,
        matchedRequirementId: candidate.id,
        confidence: learnedMatch.confidence,
      };
    }
  }

  // A filename match only earns the right to skip real content
  // classification when it's strong and confident enough to auto-approve
  // on its own — the same bar every other path in this file already has
  // to clear. Found via a real production case: "3 תלושי שכר של 3 החודשים
  // האחרונים" (a long, descriptive requirement name) gave a genuinely
  // correct file ("05_תלוש_שכר_יולי.pdf") only a 0.286 filename-token-
  // overlap score — well below the auto-approve bar, since a longer
  // candidate name mechanically dilutes the overlap ratio even for a
  // perfect semantic match. The old code treated *any* matchedRequirementId
  // here as reason enough to never even ask the AI to look at the actual
  // file content, so a readable, correctly-named payslip was filed as
  // "couldn't identify this at all" — the AI was never given the chance to
  // confirm what a human looking at the image would have seen immediately.
  const deterministic = await classifyDocument(fileName, candidates);
  if (deterministic.matchedRequirementId && deterministic.confidence >= AUTO_APPROVE_CONFIDENCE && !fileContent) {
    return deterministic;
  }

  const aiResult = await classifyDocumentViaAI(candidates, fileContent);
  if (aiResult?.matchedRequirementId) {
    return {
      supported: true,
      readable: true,
      matchedRequirementId: aiResult.matchedRequirementId,
      confidence: aiResult.confidence,
      // Carried through even on a match — resolveDocumentIntakeOutcome's
      // identity check runs regardless of whether the document type
      // matched (the right document type can still belong to the wrong
      // person), and documentIdentityVerification.ts's question wording
      // needs the real document type (e.g. "תעודת זהות") to name it
      // instead of falling back to a bare count.
      aiRan: true,
      aiDocumentType: aiResult.aiDocumentType,
      extractedPersonName: aiResult.extractedPersonName,
      extractedIdNumber: aiResult.extractedIdNumber,
      extractedCompanyName: aiResult.extractedCompanyName,
      identityExtractionConfidence: aiResult.identityExtractionConfidence,
      extractedPeriodLabel: aiResult.extractedPeriodLabel,
      periodExtractionConfidence: aiResult.periodExtractionConfidence,
      extractedReferenceNumber: aiResult.extractedReferenceNumber,
      pageNumberCurrent: aiResult.pageNumberCurrent,
      pageNumberTotal: aiResult.pageNumberTotal,
      readabilityIssue: aiResult.readabilityIssue,
      readabilityIssueDetail: aiResult.readabilityIssueDetail,
      suspectedDocumentType: aiResult.suspectedDocumentType,
      clientMessageIfProblematic: aiResult.clientMessageIfProblematic,
    };
  }
  if (aiResult) {
    // The AI ran and returned a real result, just no match — carry its
    // identification signal through so the caller can tell a confidently-
    // identified-but-unneeded document (Case 2: unsolicited) apart from a
    // genuinely unrecognizable one (Case 3), instead of collapsing both
    // into the same "needs_review" bucket. Deliberately does NOT fall back
    // to `deterministic`'s own matchedRequirementId/confidence here: real
    // content verification was just attempted and did not confirm a
    // match, so a filename that merely resembles a requirement name must
    // not silently override that and still finalize as approved — the
    // exact same guarantee the fix above provides, closing the same gap
    // for this branch too.
    return {
      supported: deterministic.supported,
      readable: deterministic.readable,
      matchedRequirementId: null,
      confidence: 0,
      aiRan: true,
      aiIdentified: aiResult.aiIdentified,
      aiDocumentType: aiResult.aiDocumentType,
      extractedPersonName: aiResult.extractedPersonName,
      extractedIdNumber: aiResult.extractedIdNumber,
      extractedCompanyName: aiResult.extractedCompanyName,
      identityExtractionConfidence: aiResult.identityExtractionConfidence,
      extractedPeriodLabel: aiResult.extractedPeriodLabel,
      periodExtractionConfidence: aiResult.periodExtractionConfidence,
      extractedReferenceNumber: aiResult.extractedReferenceNumber,
      pageNumberCurrent: aiResult.pageNumberCurrent,
      pageNumberTotal: aiResult.pageNumberTotal,
      readabilityIssue: aiResult.readabilityIssue,
      readabilityIssueDetail: aiResult.readabilityIssueDetail,
      suspectedDocumentType: aiResult.suspectedDocumentType,
      clientMessageIfProblematic: aiResult.clientMessageIfProblematic,
    };
  }

  return deterministic;
}

// Sole-outstanding-requirement fallback: WhatsApp images never carry a real
// filename (Meta's payload for an inbound photo is just a media id — see
// resolveAttachment in src/app/api/webhooks/whatsapp/route.ts, which falls
// back to a generated name like "image_<wamid>.jpg"). The filename-token
// classifier above can never score a confident match on that generated name
// against a real requirement name, so every photo a client sends would
// otherwise always land in needs_review — regardless of how unambiguous the
// match is to a human. When exactly one requirement on the request is still
// outstanding (no approved document yet), a newly-received file can only be
// answering that one open question, so it's safe to resolve it there even
// without a confident filename match. Multiple outstanding requirements stay
// needs_review exactly as before — this fallback only removes ambiguity that
// doesn't actually exist.
//
// "אין מספיק מידע כדי לזהות אותו בוודאות — אל תשייך": this is still a
// process-of-elimination GUESS, not a real identification — only ever
// applied once the AI has actually looked at the file and confirmed it's
// genuinely legible (aiRan true, no readabilityIssue). A document the AI
// never got to see at all (no file content — the sole remaining case where
// aiRan is false for a real inbound attachment) or one it saw and flagged
// as blurry/cropped/damaged/etc. must never be silently assigned to the
// sole outstanding requirement — that path already has its own explicit
// handling (needs_resend, in resolveDocumentIntakeOutcome) and must run
// instead, asking the client to resend rather than guessing.
export function resolveRequirementAssignment(
  classification: Pick<DocumentClassification, "matchedRequirementId" | "confidence" | "aiRan" | "readabilityIssue">,
  outstandingRequirementIds: string[]
): { requirementId: string | null; confidence: number } {
  if (classification.matchedRequirementId) {
    return { requirementId: classification.matchedRequirementId, confidence: classification.confidence };
  }
  if (outstandingRequirementIds.length === 1 && classification.aiRan && !classification.readabilityIssue) {
    return {
      requirementId: outstandingRequirementIds[0],
      confidence: Math.max(classification.confidence, AUTO_APPROVE_CONFIDENCE),
    };
  }
  return { requirementId: null, confidence: classification.confidence };
}

// Ch.9 duplicate detection floor for renamed files — fuzzier than M8's
// original exact-filename check: a new name built on top of the old one
// still counts as the same document (e.g. "bank-statement-jan.pdf" vs
// "bank-statement-jan-copy.pdf" — see documentClassifier.test.ts). Every
// added token dilutes the overlap, though, so this stays deliberately
// strict: two names sharing only their original tokens plus one unrelated
// addition (e.g. "bank-statement.pdf" vs "bank-statement-copy-2.pdf",
// which scores 0.5) fall below 0.7 and are correctly left undecided
// rather than auto-flagged. "Uncertain cases shall not be treated as
// duplicates automatically" (Ch.9) — this only flags high-overlap cases.
export function isFuzzyDuplicate(fileNameA: string, fileNameB: string): boolean {
  const tokensA = new Set(normalize(stripExtension(fileNameA)));
  const tokensB = new Set(normalize(stripExtension(fileNameB)));
  if (tokensA.size === 0 || tokensB.size === 0) return fileNameA === fileNameB;
  return jaccardTokenSimilarity(fileNameA, fileNameB) >= 0.7;
}
