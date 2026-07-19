/**
 * Onboarding wizard "AI Client Analysis" step — mocked (no OCR/LLM provider
 * is configured for this pilot; that requires real API credentials this
 * environment doesn't have). Real implementation would send the client name
 * (and any other imported columns) to an LLM; this uses an explicit
 * business-type column when the import file already provides one (real
 * data, not a guess) and deterministic Hebrew/English legal-suffix
 * heuristics otherwise, behind the exact same interface (matched candidate
 * + confidence) a real classifier would return — so swapping in a real
 * provider later only touches this file. Mirrors the same mock-first
 * pattern as src/lib/ai/documentClassifier.ts.
 */

export interface BusinessTypeCandidate {
  id: string;
  name: string;
}

export interface BusinessTypeClassification {
  businessTypeId: string | null;
  confidence: number;
}

// Matched against the client's name (and, for the explicit-column path,
// the imported business-type text itself) case-insensitively. Order
// matters — more specific markers first.
const SUFFIX_RULES: Array<{ pattern: RegExp; typeName: string }> = [
  { pattern: /עמותה|nonprofit|ngo|amuta/i, typeName: "Nonprofit" },
  { pattern: /עוסק פטור|exempt/i, typeName: "Exempt Business" },
  { pattern: /שכר|payroll/i, typeName: "Payroll Only" },
  { pattern: /בע"?מ|ltd\.?|inc\.?|corp\.?/i, typeName: "Limited Company" },
  { pattern: /עוסק מורשה|sole prop|self.?employed/i, typeName: "Sole Proprietor" },
];

function findCandidateByName(
  candidates: BusinessTypeCandidate[],
  typeName: string
): BusinessTypeCandidate | undefined {
  return candidates.find((c) => c.name.trim().toLowerCase() === typeName.toLowerCase());
}

// `explicitBusinessType` is the optional column an import file may already
// carry (src/lib/csv.ts's CsvClientRow.businessType) — real, office-provided
// data always wins over the heuristic guess below.
export function classifyClientBusinessType(
  clientName: string,
  candidates: BusinessTypeCandidate[],
  explicitBusinessType?: string
): BusinessTypeClassification {
  if (explicitBusinessType?.trim()) {
    const exact = findCandidateByName(candidates, explicitBusinessType.trim());
    if (exact) return { businessTypeId: exact.id, confidence: 1 };

    // The office's own label doesn't match any configured type by exact
    // name — still worth a heuristic pass over that label before giving up.
    for (const rule of SUFFIX_RULES) {
      if (rule.pattern.test(explicitBusinessType)) {
        const candidate = findCandidateByName(candidates, rule.typeName);
        if (candidate) return { businessTypeId: candidate.id, confidence: 0.9 };
      }
    }
  }

  for (const rule of SUFFIX_RULES) {
    if (rule.pattern.test(clientName)) {
      const candidate = findCandidateByName(candidates, rule.typeName);
      if (candidate) return { businessTypeId: candidate.id, confidence: 0.85 };
    }
  }

  return { businessTypeId: null, confidence: 0 };
}
