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
  "business_consultant",
  "insurance",
  "hr",
  "finance",
  "other",
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

// Smart Profession-Aware Onboarding — shared Hebrew label + icon per
// category, single source of truth for both Step 3's picker buttons and
// the wizard header's "you're setting up Centro for ___" badge (item 6:
// the selected profession must stay visible after Step 3, never forgotten).
export const BUSINESS_CATEGORY_LABELS: Record<Exclude<BusinessCategory, "other">, string> = {
  accountant: "רואה חשבון",
  tax_advisor: "יועץ מס",
  lawyer: "עורך דין",
  real_estate: "נדל״ן",
  mortgage_advisor: "יועץ משכנתאות",
  business_consultant: "ייעוץ עסקי",
  insurance: "ביטוח",
  hr: "משאבי אנוש",
  finance: "ייעוץ פיננסי",
};

export const BUSINESS_CATEGORY_ICONS: Record<Exclude<BusinessCategory, "other">, string> = {
  accountant: "🧮",
  tax_advisor: "📋",
  lawyer: "⚖️",
  real_estate: "🏠",
  mortgage_advisor: "🏦",
  business_consultant: "💼",
  insurance: "🛡️",
  hr: "👥",
  finance: "📈",
};

function isKnownCategory(value: string): value is Exclude<BusinessCategory, "other"> {
  return value !== "other" && (BUSINESS_CATEGORIES as readonly string[]).includes(value);
}

export function getBusinessCategoryLabel(category: string, customLabel?: string | null): string {
  if (isKnownCategory(category)) return BUSINESS_CATEGORY_LABELS[category];
  return customLabel?.trim() || "אחר";
}

export function getBusinessCategoryIcon(category: string): string {
  return isKnownCategory(category) ? BUSINESS_CATEGORY_ICONS[category] : "🏢";
}
