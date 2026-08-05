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
  const fileTokens = normalize(baseName);
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
async function classifyDocumentViaAI(
  candidates: DocumentClassificationCandidate[],
  fileContent: ClassifiableFileContent | undefined
): Promise<{ matchedRequirementId: string; confidence: number } | null> {
  if (!fileContent) return null;
  const result = await classifyDocumentViaVisionAI(fileContent.bytes, fileContent.mimeType, candidates);
  if (!result?.matchedRequirementId) return null;
  return { matchedRequirementId: result.matchedRequirementId, confidence: result.confidence };
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

  const learnedMatch = matchLearnedPattern(fileName, learnedPatterns);
  if (learnedMatch) {
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

  const deterministic = await classifyDocument(fileName, candidates);
  if (deterministic.matchedRequirementId) return deterministic;

  const aiMatch = await classifyDocumentViaAI(candidates, fileContent);
  if (aiMatch) {
    return {
      supported: true,
      readable: true,
      matchedRequirementId: aiMatch.matchedRequirementId,
      confidence: aiMatch.confidence,
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
export function resolveRequirementAssignment(
  classification: Pick<DocumentClassification, "matchedRequirementId" | "confidence">,
  outstandingRequirementIds: string[]
): { requirementId: string | null; confidence: number } {
  if (classification.matchedRequirementId) {
    return { requirementId: classification.matchedRequirementId, confidence: classification.confidence };
  }
  if (outstandingRequirementIds.length === 1) {
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
