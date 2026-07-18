/**
 * Ch.9/Ch.11 document classification & matching — mocked (no OCR/LLM
 * provider is configured for this pilot; that requires real API
 * credentials this environment doesn't have). Real implementation runs
 * OCR then an LLM classification call; this uses filename validation and
 * keyword-token overlap against the candidate requirement names as a
 * deterministic stand-in with the exact same interface (supported /
 * readable / matched requirement / confidence), so swapping in a real
 * provider later only touches this file.
 */

export const SUPPORTED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "heic"];

// Confidence at/above this auto-approves (PR-002 "AI Assists — Humans
// Decide" still applies below it: anything less certain lands in
// needs_review for a person to resolve, per BR-11.3).
export const AUTO_APPROVE_CONFIDENCE = 0.6;

export interface DocumentClassification {
  supported: boolean;
  readable: boolean;
  matchedRequirementId: string | null;
  confidence: number;
}

function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9א-ת]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export async function classifyDocument(
  fileName: string,
  candidates: Array<{ id: string; name: string }>
): Promise<DocumentClassification> {
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
  const supported = SUPPORTED_EXTENSIONS.includes(extension);
  if (!supported) {
    return { supported: false, readable: false, matchedRequirementId: null, confidence: 0 };
  }

  // FR-11.3 stand-in: a real OCR call fails on unreadable scans; here, a
  // suspiciously short base name plays that role deterministically.
  const baseName = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  if (baseName.trim().length < 2) {
    return { supported: true, readable: false, matchedRequirementId: null, confidence: 0 };
  }

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

// Ch.9 duplicate detection floor for renamed files — fuzzier than M8's
// original exact-filename check: same normalized tokens count as the
// same document even with a different name (e.g. "bank-statement.pdf" vs
// "bank-statement-copy-2.pdf"). "Uncertain cases shall not be treated as
// duplicates automatically" (Ch.9) — this only flags high-overlap cases.
export function isFuzzyDuplicate(fileNameA: string, fileNameB: string): boolean {
  const tokensA = new Set(normalize(fileNameA));
  const tokensB = new Set(normalize(fileNameB));
  if (tokensA.size === 0 || tokensB.size === 0) return fileNameA === fileNameB;

  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union >= 0.7;
}
