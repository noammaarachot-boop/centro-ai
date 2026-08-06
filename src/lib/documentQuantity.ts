import type { DocumentClassification } from "@/lib/ai/documentClassifier";

/**
 * Quantity-aware requirement engine — a requirement can ask for more than
 * one document ("3 תלושי שכר", "דפי בנק של 3 חודשים"), tracked via
 * collectionRequestRequirements.requiredCount (default 1, preserving
 * today's exactly-one-document behavior for every existing requirement
 * unchanged). This module is the one place that decides whether a
 * requirement's units are actually satisfied, from the dated period each
 * approved document was extracted to cover — never from a raw document
 * count alone, which would let three payslips for the same month look like
 * three distinct months.
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

// The one place "is this requirement done?" is decided once more than one
// unit can be required. Two approved documents sharing the same extracted
// period label count as ONE satisfied unit, not two (the "3 payslips, but 2
// are for the same month" scenario — the requirement stays open until a
// genuinely distinct third period arrives, no client interruption needed:
// see caseReview.ts's missing-requirements wording, which is what actually
// surfaces this to the client, only once, at finish time).
//
// A document with no period label at all (extraction failed, or this
// requirement's documents just aren't the dated kind) is never treated as a
// potential duplicate of another such document — there's no reliable signal
// to compare, and silently under-counting real documents because extraction
// has a gap would be a worse failure mode than the rare case of two
// genuinely-same-period documents both counting as distinct units when
// neither could be dated. This keeps the fallback permissive: never block
// completion on an AI extraction limitation.
export function computeRequirementSatisfaction(
  requiredCount: number,
  periodLabels: Array<string | null>
): RequirementSatisfaction {
  const distinctLabels = new Set(periodLabels.filter((label): label is string => label !== null));
  const undatedCount = periodLabels.filter((label) => label === null).length;
  const satisfiedCount = distinctLabels.size + undatedCount;
  return { satisfiedCount, satisfied: satisfiedCount >= requiredCount };
}
