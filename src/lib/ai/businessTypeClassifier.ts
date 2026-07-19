import type { CanonicalBusinessTypeKey } from "@/lib/businessTypes";

/**
 * Onboarding wizard's client business-type classification — Epic 4's
 * multi-layer pipeline, in strict priority order:
 *
 *   1. Deterministic dictionary match, in two steps ordered most-specific
 *      first:
 *        a. Learned synonyms (per-organization — see src/lib/businessTypes.ts's
 *           getLearnedSynonyms/recordLearnedSynonyms). A specific office's own
 *           past correction is a stronger signal than a generic dictionary
 *           entry, and it can never affect any other organization.
 *        b. The global BUSINESS_TYPE_SYNONYMS dictionary below, against an
 *           explicit business-type column when the import file provides one.
 *      Confidence 99 — real, office-supplied (or previously confirmed) data.
 *   2. Context inference — when step 1 found nothing (no explicit column, or
 *      its value didn't match anything known), the same two dictionaries are
 *      checked again against the *rest of the row*: the client's name first
 *      (many offices embed the type there, e.g. a company name ending in
 *      "בע\"מ"), then every other non-empty textual cell in the row. This is
 *      still deterministic matching, just against different input — never a
 *      guess. Confidence 85 (comfortably in the wizard's "suggested,
 *      auto-applied but flagged" band).
 *   3. AI fallback (classifyViaAI) — only reached once steps 1-2 have both
 *      failed. No LLM/OCR provider is configured for this pilot (same
 *      "mock-first" decision as src/lib/ai/documentClassifier.ts), so this
 *      is currently a documented no-op stub, not a fake/random guess —
 *      wiring in a real provider later only touches this one function, and
 *      per its contract it must never run before steps 1-2 have had a
 *      chance. It receives the *entire row*, not one cell, and must return
 *      a business type with its own confidence and a human-readable reason.
 *   4. Unclassified (null, confidence 0) — always available for manual
 *      assignment in the wizard's Step 5, never silently guessed.
 *
 * The caller (src/app/onboarding/actions.ts) applies the wizard's
 * confidence bands on top of whatever this returns: >=95 auto-classifies
 * silently, 70-94 auto-classifies but is flagged "suggested," and below 70
 * is left unclassified and routed to manual review — this module only
 * ever reports a confidence, it never decides what to do with it.
 */

export interface BusinessTypeCandidate {
  id: string;
  name: string;
  canonicalKey: string | null;
}

// The wizard's confidence bands (Epic 4 STEP 4), defined once here since
// Milestone 1 (src/app/(app)/clients/actions.ts) reuses this exact
// classifier — and the exact same bands — for manually-created clients,
// not only bulk import.
export const AUTO_CLASSIFY_CONFIDENCE = 95;
export const SUGGESTED_CONFIDENCE = 70;

// Everything else in the imported row besides the name/explicit-type
// columns already consumed elsewhere — src/lib/csv.ts's
// buildClientRowsFromMapping populates this from whatever columns weren't
// claimed by any other role (city, notes, a stray "legal form" column,
// etc.), so context inference (layer 2) can search all of it, not just the
// client's name.
export interface RowContext {
  clientName: string;
  explicitBusinessType?: string;
  otherValues?: string[];
}

export interface BusinessTypeClassification {
  businessTypeId: string | null;
  canonicalKey: string | null;
  /** 0-100, never a fraction — matches the wizard's confidence bands. */
  confidence: number;
  method: "learned-synonym" | "explicit-dictionary" | "context-inference" | "ai" | "unclassified";
  /** Human-readable, surfaced in the UI/audit trail for transparency. */
  reason: string;
}

// Canonical keys — must match src/lib/businessTypes.ts's
// STARTER_BUSINESS_TYPES' canonicalKey values exactly, since matching a
// synonym here only helps if findCandidateByCanonicalKey can then find the
// org's actual business_types row by that same key. Ordered
// longest-synonym-first within each entry so a specific phrase
// ("עוסק מורשה") is preferred over a bare word ("מורשה") when both would
// match — not that it matters for the result (same canonical type either
// way), but it keeps the intent explicit.
export const BUSINESS_TYPE_SYNONYMS: Record<CanonicalBusinessTypeKey, string[]> = {
  limited_company: [
    'חברה בע"מ',
    "חברה בעמ",
    'בע"מ',
    "בעמ",
    "חברה",
    "ltd.",
    "ltd",
    "limited",
    "limited company",
    "inc.",
    "inc",
    "corp.",
    "corp",
    "corporation",
    "company",
  ],
  authorized_dealer: [
    "עוסק מורשה",
    "עוסק/ת מורשה",
    "ע. מורשה",
    "ע.מורשה",
    'ע"מ מורשה',
    "מורשה",
    "sole proprietor",
    "sole prop",
    "authorized dealer",
    "authorized business",
    "self-employed",
    "self employed",
  ],
  exempt_dealer: [
    "עוסק פטור",
    "עוסק/ת פטור",
    "ע. פטור",
    "ע.פטור",
    "פטור",
    "exempt business",
    "exempt dealer",
    "exempt",
  ],
  nonprofit: [
    "עמותה",
    "עמותת",
    'מלכ"ר',
    "מלכר",
    'חל"צ',
    "חלץ",
    "nonprofit",
    "non-profit",
    "ngo",
    "amuta",
  ],
  payroll_only: ["שכר בלבד", "שכר", "payroll only", "payroll"],
};

// Longest-first across ALL entries (not just within one), so e.g. "עוסק
// מורשה" is tested before a hypothetical shorter unrelated synonym that
// might otherwise match a substring of it first.
const FLAT_SYNONYMS: Array<{ canonicalKey: CanonicalBusinessTypeKey; synonym: string }> =
  Object.entries(BUSINESS_TYPE_SYNONYMS)
    .flatMap(([canonicalKey, synonyms]) =>
      synonyms.map((synonym) => ({ canonicalKey: canonicalKey as CanonicalBusinessTypeKey, synonym }))
    )
    .sort((a, b) => b.synonym.length - a.synonym.length);

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Exported for src/lib/import/columnAnalyzer.ts — the column-inference
// layer scores a candidate "business type" column by how many of its cell
// values this same dictionary recognizes, so a column is identified by
// what its values actually mean, not by trusting its header.
export function matchSynonym(text: string): CanonicalBusinessTypeKey | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const { canonicalKey, synonym } of FLAT_SYNONYMS) {
    if (normalized.includes(normalize(synonym))) return canonicalKey;
  }
  return null;
}

function findCandidateByCanonicalKey(
  candidates: BusinessTypeCandidate[],
  canonicalKey: CanonicalBusinessTypeKey
): BusinessTypeCandidate | undefined {
  return candidates.find((c) => c.canonicalKey === canonicalKey);
}

function findCandidateByName(
  candidates: BusinessTypeCandidate[],
  name: string
): BusinessTypeCandidate | undefined {
  const target = name.trim().toLowerCase();
  return candidates.find((c) => c.name.trim().toLowerCase() === target);
}

// Deterministic match (dictionary + exact-name fallback) against one piece
// of text — shared by layer 1 (explicit column) and layer 2 (row context),
// which differ only in *which* text they check, never in how matching
// works.
function matchDeterministic(
  text: string,
  candidates: BusinessTypeCandidate[]
): BusinessTypeCandidate | undefined {
  const canonicalKey = matchSynonym(text);
  if (canonicalKey) {
    const candidate = findCandidateByCanonicalKey(candidates, canonicalKey);
    if (candidate) return candidate;
  }
  return findCandidateByName(candidates, text);
}

// Stub — see the module doc comment above. Deliberately never called
// before both deterministic passes (explicit column, then row context)
// have already failed. Receives the whole row, not one cell, and must
// report its own confidence and reasoning — never a bare guess.
/* eslint-disable @typescript-eslint/no-unused-vars */
async function classifyViaAI(
  _row: RowContext,
  _candidates: BusinessTypeCandidate[]
): Promise<{ businessType: BusinessTypeCandidate; confidence: number; reason: string } | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

export async function classifyClientBusinessType(
  row: RowContext,
  candidates: BusinessTypeCandidate[],
  learnedSynonyms?: Map<string, string>
): Promise<BusinessTypeClassification> {
  const explicitText = row.explicitBusinessType?.trim();

  // 1a. Learned synonym on the explicit column — this organization's own
  // past correction, the single strongest signal available.
  if (explicitText) {
    const learnedId = learnedSynonyms?.get(normalize(explicitText));
    if (learnedId) {
      const candidate = candidates.find((c) => c.id === learnedId);
      if (candidate) {
        return {
          businessTypeId: candidate.id,
          canonicalKey: candidate.canonicalKey,
          confidence: 99,
          method: "learned-synonym",
          reason: `זוהה על סמך תיקון קודם שביצע המשרד עבור הערך "${explicitText}"`,
        };
      }
    }
  }

  // 1b. Global deterministic dictionary on the explicit column.
  if (explicitText) {
    const candidate = matchDeterministic(explicitText, candidates);
    if (candidate) {
      return {
        businessTypeId: candidate.id,
        canonicalKey: candidate.canonicalKey,
        confidence: 99,
        method: "explicit-dictionary",
        reason: `הערך "${explicitText}" בעמודת סוג העסק תואם ל"${candidate.name}"`,
      };
    }
  }

  // 2. Context inference — the rest of the row. Client name first (a
  // company name embedding its legal form is the most common real-world
  // case), then every other non-empty cell.
  const contextPieces = [row.clientName, ...(row.otherValues ?? [])].filter(Boolean);
  for (const piece of contextPieces) {
    const learnedId = learnedSynonyms?.get(normalize(piece));
    if (learnedId) {
      const candidate = candidates.find((c) => c.id === learnedId);
      if (candidate) {
        return {
          businessTypeId: candidate.id,
          canonicalKey: candidate.canonicalKey,
          confidence: 85,
          method: "context-inference",
          reason: `זוהה על סמך תיקון קודם שביצע המשרד, מתוך "${piece}"`,
        };
      }
    }
    const candidate = matchDeterministic(piece, candidates);
    if (candidate) {
      return {
        businessTypeId: candidate.id,
        canonicalKey: candidate.canonicalKey,
        confidence: 85,
        method: "context-inference",
        reason: `זוהה מתוך "${piece}" בשורת הלקוח (לא מעמודת סוג עסק ייעודית)`,
      };
    }
  }

  // 3. AI fallback — only after every deterministic pass has failed.
  const aiMatch = await classifyViaAI(row, candidates);
  if (aiMatch) {
    return {
      businessTypeId: aiMatch.businessType.id,
      canonicalKey: aiMatch.businessType.canonicalKey,
      confidence: aiMatch.confidence,
      method: "ai",
      reason: aiMatch.reason,
    };
  }

  return {
    businessTypeId: null,
    canonicalKey: null,
    confidence: 0,
    method: "unclassified",
    reason: "לא נמצא סימן מובהק לסוג העסק בעמודת הסוג, בשם הלקוח או בשאר השורה",
  };
}
