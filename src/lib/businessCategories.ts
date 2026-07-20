// Product Evolution M1: the office's own declared business category —
// distinct from clients.businessTypeId/business_types (which classify this
// office's *clients* and remain a Workflow-A-only concept). Nine presets,
// the last ("other") requiring a free-text label (organizations.
// businessCategoryCustomLabel). Drives M2's onboarding document-suggestion
// defaults and personalization; the recurring learning engine itself never
// reads this value.
export const BUSINESS_CATEGORIES = [
  "accountant",
  "tax_advisor",
  "lawyer",
  "real_estate",
  "mortgage_advisor",
  "insurance",
  "hr",
  "finance",
  "other",
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
