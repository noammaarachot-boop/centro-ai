import type { DocumentClassification } from "@/lib/ai/documentClassifier";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";
import { nameMatchScore } from "@/lib/documentIdentityVerification";

/**
 * Quantity-aware requirement engine — a requirement can ask for more than
 * one document ("3 תלושי שכר", "דפי בנק של 3 חודשים"), tracked via
 * collectionRequestRequirements.requiredCount (default 1, preserving
 * today's exactly-one-document behavior for every existing requirement
 * unchanged). This module is the one place that decides whether a
 * requirement's units are actually satisfied.
 *
 * Since the semantic requirement engine (src/lib/ai/requirementSemantics.ts),
 * "satisfied" is decided against the office user's own stated meaning
 * (RequirementSemanticSpec) — never a single global rule. "3 payslips for 3
 * different months" and "3 payslips for June" are different requirements
 * with different satisfaction rules, both expressed through the same
 * requiredCount; a requirement with no parsed spec (a legacy row, or an
 * ad-hoc client-profile addition — see clientDocumentProfile.ts) falls back
 * to the original distinct-period-or-undated-counts-as-one-unit algorithm
 * this module shipped with before the semantic engine existed.
 */

// Below this, the vision model's own period extraction is too unreliable to
// act on — the document is treated as having no period at all (see
// computeRequirementSatisfaction's own null-handling), never a guessed date.
const MIN_PERIOD_EXTRACTION_CONFIDENCE = 0.5;

// Only ever called once real, above-floor extraction actually happened —
// mirrors extractedIdentityForStorage's own discipline (documentIdentityVerification.ts):
// a low-confidence guess must never be written to the database, since a
// later sibling document compares against exactly what's stored here.
export function extractedPeriodLabelForStorage(
  classification: Pick<DocumentClassification, "aiRan" | "extractedPeriodLabel" | "periodExtractionConfidence">
): string | null {
  if (!classification.aiRan) return null;
  if ((classification.periodExtractionConfidence ?? 0) < MIN_PERIOD_EXTRACTION_CONFIDENCE) return null;
  return classification.extractedPeriodLabel ?? null;
}

export interface RequirementSatisfaction {
  // How many of the requirement's requiredCount units are actually covered.
  satisfiedCount: number;
  satisfied: boolean;
}

export interface SatisfactionDocument {
  periodLabel: string | null;
  personName: string | null;
}

interface RequirementForSatisfaction {
  requiredCount: number;
  semanticSpec: unknown;
  // "I don't have this document" exception (src/lib/requirementException.ts)
  // — "waived" is the one exception outcome that force-satisfies a
  // requirement regardless of documents; every other value (or undefined,
  // for a caller that doesn't track this at all) has no effect here.
  exceptionStatus?: string | null;
}

// Fuzzy-groups names into equivalence classes (reusing the same tolerance
// documentIdentityVerification.ts's identity-anomaly detection already
// relies on — reversed word order, OCR noise, partial spelling all still
// count as "the same person") and returns how many distinct people that
// produces. A document with no extracted name at all is never assumed to
// be a duplicate of another undated/unnamed one — each counts as its own
// distinct unit, the same permissive default computeRequirementSatisfaction
// applies to undated documents.
function countDistinctPeople(names: string[]): number {
  const clusters: string[][] = [];
  for (const name of names) {
    const cluster = clusters.find((c) => nameMatchScore(name, c[0]) >= 0.6);
    if (cluster) cluster.push(name);
    else clusters.push([name]);
  }
  return clusters.length;
}

// The one place "is this requirement done?" is decided. `requirement.semanticSpec`
// (RequirementSemanticSpec | null) drives everything:
//
//   - no spec (legacy/ad-hoc): distinct period labels count as separate
//     units, undated documents each count as their own unit too (never
//     block completion on an extraction gap).
//   - periodType "explicit" with explicitPeriods set: only documents whose
//     period matches one of the explicit periods count at all (an
//     undated document is still given the benefit of the doubt and counted).
//   - distinctPeopleRequired: units are counted by distinct person
//     (fuzzy-matched), not by document or period.
//   - distinctPeriodsRequired: units are counted by distinct period label
//     (same as the legacy algorithm, but only ever applied when the office
//     user's own wording actually asked for distinct periods).
//   - samePeriodAllowed (or no distinctness constraint at all): every
//     matching document counts as its own unit — duplicates of the same
//     period are expected, not a red flag.
export function computeRequirementSatisfaction(
  requirement: RequirementForSatisfaction,
  documents: SatisfactionDocument[]
): RequirementSatisfaction {
  const requiredCount = requirement.requiredCount;
  const spec = requirement.semanticSpec as RequirementSemanticSpec | null;

  if (requirement.exceptionStatus === "waived") {
    return { satisfiedCount: requiredCount, satisfied: true };
  }

  if (!spec) {
    const distinctLabels = new Set(documents.map((d) => d.periodLabel).filter((label): label is string => label !== null));
    const undatedCount = documents.filter((d) => d.periodLabel === null).length;
    const satisfiedCount = distinctLabels.size + undatedCount;
    return { satisfiedCount, satisfied: satisfiedCount >= requiredCount };
  }

  let relevant = documents;
  if (spec.periodType === "explicit" && spec.explicitPeriods && spec.explicitPeriods.length > 0) {
    const allowed = new Set(spec.explicitPeriods);
    relevant = documents.filter((d) => d.periodLabel === null || allowed.has(d.periodLabel));
  }

  if (spec.distinctPeopleRequired) {
    const named = relevant.filter((d): d is SatisfactionDocument & { personName: string } => !!d.personName);
    const unnamedCount = relevant.length - named.length;
    const satisfiedCount = countDistinctPeople(named.map((d) => d.personName)) + unnamedCount;
    return { satisfiedCount, satisfied: satisfiedCount >= requiredCount };
  }

  if (spec.distinctPeriodsRequired) {
    const distinctLabels = new Set(relevant.map((d) => d.periodLabel).filter((label): label is string => label !== null));
    const undatedCount = relevant.filter((d) => d.periodLabel === null).length;
    const satisfiedCount = distinctLabels.size + undatedCount;
    return { satisfiedCount, satisfied: satisfiedCount >= requiredCount };
  }

  // samePeriodAllowed, or no distinctness constraint stated at all —
  // duplicates are fine/expected, just count how many relevant documents
  // there are.
  const satisfiedCount = relevant.length;
  return { satisfiedCount, satisfied: satisfiedCount >= requiredCount };
}
