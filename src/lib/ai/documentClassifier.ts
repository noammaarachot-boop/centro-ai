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

export interface DocumentClassificationCandidate {
  id: string;
  name: string;
  /** serviceDocumentRequirements.id, when this cycle's requirement traces back to a template — null for a one-off, cycle-only requirement with nothing to learn against. */
  sourceRequirementId?: string | null;
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

function jaccardTokenSimilarity(fileNameA: string, fileNameB: string): number {
  const tokensA = new Set(normalize(fileNameA));
  const tokensB = new Set(normalize(fileNameB));
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

// Ch.6 layer 3 (AI) — reached only once Learned Knowledge and the
// deterministic heuristic have both failed to confidently match. No OCR/
// LLM provider is configured for this pilot (same mock-first pattern as
// every other AI seam in this codebase) — a documented no-op, never a
// fake guess. Wiring in a real provider later touches only this function.
/* eslint-disable @typescript-eslint/no-unused-vars */
async function classifyDocumentViaAI(
  _fileName: string,
  _candidates: Array<{ id: string; name: string }>
): Promise<{ matchedRequirementId: string; confidence: number } | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

// The full 4-layer pipeline: Learned Knowledge -> Business Rules -> AI ->
// (implicitly) Human Review, via the same needs_review fallthrough that
// already existed. Layer 4 is never returned from here directly — an
// unmatched result routes to needs_review exactly as it always has, in
// the caller (src/app/(app)/collections/conversationActions.ts).
export async function classifyDocumentWithLearning(
  fileName: string,
  candidates: DocumentClassificationCandidate[],
  learnedPatterns: LearnedDocumentPattern[]
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

  const aiMatch = await classifyDocumentViaAI(fileName, candidates);
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

// Ch.9 duplicate detection floor for renamed files — fuzzier than M8's
// original exact-filename check: same normalized tokens count as the
// same document even with a different name (e.g. "bank-statement.pdf" vs
// "bank-statement-copy-2.pdf"). "Uncertain cases shall not be treated as
// duplicates automatically" (Ch.9) — this only flags high-overlap cases.
export function isFuzzyDuplicate(fileNameA: string, fileNameB: string): boolean {
  const tokensA = new Set(normalize(fileNameA));
  const tokensB = new Set(normalize(fileNameB));
  if (tokensA.size === 0 || tokensB.size === 0) return fileNameA === fileNameB;
  return jaccardTokenSimilarity(fileNameA, fileNameB) >= 0.7;
}
