/**
 * Onboarding wizard "AI Client Analysis" step — client business-type
 * classification, in strict priority order:
 *
 *   1. Deterministic dictionary match (BUSINESS_TYPE_SYNONYMS below)
 *      against an explicit business-type column, when the import file
 *      provides one — real, office-supplied data, matched against the
 *      standard Israeli accounting terms and their common synonyms/
 *      abbreviations. This is the primary path and covers the overwhelming
 *      majority of real files.
 *   2. AI fallback (classifyViaAI) — only reached if step 1 found nothing.
 *      No LLM/OCR provider is configured for this pilot (same "mock-first"
 *      decision as src/lib/ai/documentClassifier.ts), so this is currently
 *      a documented no-op stub, not a fake/random guess — wiring in a real
 *      provider later only touches this one function, and per its
 *      contract it must never run before step 1 has had a chance.
 *   3. Deterministic dictionary match against the client's *name* itself
 *      (some offices embed the type there instead of a separate column) —
 *      lower confidence, last resort before giving up.
 *   4. Unclassified (null) — always available for manual assignment in the
 *      wizard's Step 5, never silently guessed.
 */

export interface BusinessTypeCandidate {
  id: string;
  name: string;
}

export interface BusinessTypeClassification {
  businessTypeId: string | null;
  confidence: number;
  /** Which stage matched — surfaced in the UI/audit trail for transparency. */
  method: "explicit-dictionary" | "ai" | "name-dictionary" | "unclassified";
}

// Canonical Hebrew names — must match src/lib/businessTypes.ts's
// STARTER_BUSINESS_TYPES exactly, since matching a synonym here only helps
// if `findCandidateByName` can then find the org's actual business_types
// row by that same name. Ordered longest-synonym-first within each entry
// so a specific phrase ("עוסק מורשה") is preferred over a bare word
// ("מורשה") when both would match — not that it matters for the result
// here (same canonical type either way), but it keeps the intent explicit.
export const BUSINESS_TYPE_SYNONYMS: Record<string, string[]> = {
  'חברה בע"מ': [
    'חברה בע"מ',
    "חברה בעמ",
    'בע"מ',
    "בעמ",
    "חברה",
    "ltd.",
    "ltd",
    "limited",
    "inc.",
    "inc",
    "corp.",
    "corp",
    "corporation",
    "company",
  ],
  "עוסק מורשה": [
    "עוסק מורשה",
    "עוסק/ת מורשה",
    "מורשה",
    "sole proprietor",
    "sole prop",
    "authorized dealer",
    "authorized business",
    "self-employed",
    "self employed",
  ],
  "עוסק פטור": [
    "עוסק פטור",
    "עוסק/ת פטור",
    "פטור",
    "exempt business",
    "exempt dealer",
    "exempt",
  ],
  עמותה: ["עמותה", "עמותת", "nonprofit", "non-profit", "ngo", "amuta"],
  "שכר בלבד": ["שכר בלבד", "שכר", "payroll only", "payroll"],
};

// Longest-first across ALL entries (not just within one), so e.g. "עוסק
// מורשה" is tested before a hypothetical shorter unrelated synonym that
// might otherwise match a substring of it first.
const FLAT_SYNONYMS: Array<{ canonicalName: string; synonym: string }> = Object.entries(
  BUSINESS_TYPE_SYNONYMS
)
  .flatMap(([canonicalName, synonyms]) => synonyms.map((synonym) => ({ canonicalName, synonym })))
  .sort((a, b) => b.synonym.length - a.synonym.length);

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchSynonym(text: string): string | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const { canonicalName, synonym } of FLAT_SYNONYMS) {
    if (normalized.includes(normalize(synonym))) return canonicalName;
  }
  return null;
}

function findCandidateByName(
  candidates: BusinessTypeCandidate[],
  name: string
): BusinessTypeCandidate | undefined {
  const target = name.trim().toLowerCase();
  return candidates.find((c) => c.name.trim().toLowerCase() === target);
}

// Stub — see the module doc comment above. Deliberately never called
// before the deterministic dictionary pass has already failed.
/* eslint-disable @typescript-eslint/no-unused-vars */
async function classifyViaAI(
  _clientName: string,
  _candidates: BusinessTypeCandidate[],
  _explicitBusinessType: string | undefined
): Promise<BusinessTypeCandidate | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

export async function classifyClientBusinessType(
  clientName: string,
  candidates: BusinessTypeCandidate[],
  explicitBusinessType?: string
): Promise<BusinessTypeClassification> {
  // 1. Deterministic dictionary match on the explicit column.
  if (explicitBusinessType?.trim()) {
    const canonicalName = matchSynonym(explicitBusinessType);
    if (canonicalName) {
      const candidate = findCandidateByName(candidates, canonicalName);
      if (candidate) {
        return { businessTypeId: candidate.id, confidence: 1, method: "explicit-dictionary" };
      }
    }
    // Also allow an exact match against the org's actual (possibly custom)
    // type names, in case the file already uses the org's own wording.
    const exact = findCandidateByName(candidates, explicitBusinessType);
    if (exact) {
      return { businessTypeId: exact.id, confidence: 1, method: "explicit-dictionary" };
    }
  }

  // 2. AI fallback — only after deterministic matching found nothing.
  const aiMatch = await classifyViaAI(clientName, candidates, explicitBusinessType);
  if (aiMatch) {
    return { businessTypeId: aiMatch.id, confidence: 0.7, method: "ai" };
  }

  // 3. Last resort — the type embedded in the client's name itself.
  const nameMatch = matchSynonym(clientName);
  if (nameMatch) {
    const candidate = findCandidateByName(candidates, nameMatch);
    if (candidate) {
      return { businessTypeId: candidate.id, confidence: 0.6, method: "name-dictionary" };
    }
  }

  return { businessTypeId: null, confidence: 0, method: "unclassified" };
}
