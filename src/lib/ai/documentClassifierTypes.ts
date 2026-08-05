// Shared between documentClassifier.ts (pure filename heuristic) and
// documentVisionClassifier.ts (real AI vision classification) — split out
// so the vision module, which does live network I/O, never needs a runtime
// import from the pure/testable classifier module.
export interface DocumentClassificationCandidate {
  id: string;
  name: string;
  /** serviceDocumentRequirements.id, when this cycle's requirement traces back to a template — null for a one-off, cycle-only requirement with nothing to learn against. */
  sourceRequirementId?: string | null;
}
