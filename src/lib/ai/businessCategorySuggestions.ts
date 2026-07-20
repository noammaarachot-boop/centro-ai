import type { StarterBusinessType } from "@/lib/businessTypes";

/**
 * Product Evolution M2 — generalizes Workflow A's onboarding starter
 * defaults beyond the hardcoded 5 Israeli accounting client-types, per the
 * office's own declared business category
 * (organizations.businessCategory/businessCategoryCustomLabel, Milestone 1).
 *
 * Same "mocked but real interface" pattern as every other AI module in this
 * codebase (src/lib/ai/documentClassifier.ts,
 * src/lib/ai/businessTypeClassifier.ts): no LLM/OCR provider is configured
 * for this pilot, so `suggestStarterBusinessTypes` is genuinely async and
 * returns a real, useful result today via curated domain knowledge plus
 * keyword matching — wiring in a real provider later only touches this one
 * function's body, never its callers or return shape.
 *
 * The product requirement this module exists to satisfy: an office that
 * enters a business type Centro has never seen before must still get a
 * specific, non-empty, plausible starting point — never a literal "unknown
 * business" placeholder. Coverage works in three tiers:
 *   1. accountant/tax_advisor — handled entirely by the caller
 *      (src/lib/businessTypes.ts's seedStarterBusinessTypes), which keeps
 *      today's exact hardcoded STARTER_BUSINESS_TYPES untouched. This
 *      module is never even called for those two categories.
 *   2. The other 6 known presets (lawyer, real_estate, mortgage_advisor,
 *      insurance, hr, finance) — a curated, specific starter set each.
 *   3. "other" with a free-text label — matched against a much broader
 *      keyword dictionary covering ~15 additional common business domains
 *      (medical, education, construction, automotive, tech, retail,
 *      veterinary, architecture, travel, fitness, events, beauty, food/
 *      hospitality, cleaning) before falling back to the one truly
 *      unrecognized case — and even then, the fallback names its starter
 *      type after the office's own words ("לקוחות {label}"), not a generic
 *      placeholder, so the result always reads as specific to what was
 *      typed even when the underlying checklist is a safe, broad default.
 *
 * These are only starting suggestions — the office edits/removes/adds
 * documents freely from Step 6 onward, and the recurring learning engine
 * (Architecture Ch.1–8) takes over from there exactly as it always has,
 * regardless of which business category or tier produced the starting
 * point.
 */

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugify(value: string): string {
  return (
    normalize(value)
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "custom"
  );
}

const PRESET_STARTERS: Record<string, StarterBusinessType[]> = {
  lawyer: [
    {
      name: "לקוח פרטי",
      canonicalKey: "pe:lawyer:individual",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "ייפוי כוח", defaultChecked: true },
        { name: "הסכם שכר טרחה", defaultChecked: true },
        { name: "מסמכים הנוגעים לתיק", defaultChecked: false },
      ],
    },
    {
      name: "לקוח עסקי",
      canonicalKey: "pe:lawyer:corporate",
      suggestedRequirements: [
        { name: "תעודת התאגדות", defaultChecked: true },
        { name: "ייפוי כוח", defaultChecked: true },
        { name: "הסכם שכר טרחה", defaultChecked: true },
        { name: "תמצית רישום חברה", defaultChecked: false },
      ],
    },
  ],
  real_estate: [
    {
      name: "רוכש נכס",
      canonicalKey: "pe:real_estate:buyer",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "אישור עקרוני ממימון/בנק", defaultChecked: true },
        { name: "חוזה רכישה", defaultChecked: false },
      ],
    },
    {
      name: "מוכר נכס",
      canonicalKey: "pe:real_estate:seller",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "נסח טאבו", defaultChecked: true },
        { name: "חוזה מכירה", defaultChecked: false },
      ],
    },
    {
      name: "שוכר",
      canonicalKey: "pe:real_estate:tenant",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "תלושי שכר", defaultChecked: true },
        { name: "חוזה שכירות", defaultChecked: false },
      ],
    },
  ],
  mortgage_advisor: [
    {
      name: "בקשת משכנתא",
      canonicalKey: "pe:mortgage_advisor:application",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "תלושי שכר", defaultChecked: true },
        { name: "דפי חשבון בנק", defaultChecked: true },
        { name: "אישור עקרוני מהבנק", defaultChecked: true },
        { name: "חוזה רכישה", defaultChecked: false },
      ],
    },
  ],
  insurance: [
    {
      name: "לקוח ביטוח",
      canonicalKey: "pe:insurance:client",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "טופס הצעה/הצטרפות לביטוח", defaultChecked: true },
        { name: "מסמכים רפואיים", defaultChecked: false },
      ],
    },
  ],
  hr: [
    {
      name: "עובד חדש",
      canonicalKey: "pe:hr:new_employee",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: 'טופס 101', defaultChecked: true },
        { name: "אישור ניהול חשבון בנק", defaultChecked: true },
        { name: "קורות חיים", defaultChecked: false },
        { name: "תעודות השכלה", defaultChecked: false },
      ],
    },
  ],
  finance: [
    {
      name: "לקוח ייעוץ פיננסי",
      canonicalKey: "pe:finance:client",
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "דפי חשבון בנק", defaultChecked: true },
        { name: "דוחות/תיק השקעות", defaultChecked: false },
      ],
    },
  ],
};

// Additional domains recognized only via keyword matching against a free-
// text "Other" label — broadens tier 3's coverage well past the 6 formal
// presets above, so far fewer real-world "Other" entries ever reach the
// last-resort fallback.
const KEYWORD_DOMAINS: Array<{ keywords: string[]; starters: StarterBusinessType[] }> = [
  {
    // "קליניק" alone is deliberately excluded here — it's a substring of
    // "קליניקה וטרינרית" (veterinary clinic) too, and without a more
    // specific human/medical phrase it would win ties by coincidence
    // rather than genuine relevance. Longest-match-first (see
    // matchKeywordDomain) still means a real ambiguous case always
    // prefers whichever domain's phrase is more specific/longer.
    keywords: ["רפואי", "מרפאה", "medical", "clinic", "doctor", "health"],
    starters: [
      {
        name: "מטופל",
        canonicalKey: "pe:medical:patient",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "טופס הסכמה מדעת", defaultChecked: true },
          { name: "היסטוריה רפואית / הפניה", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["חינוך", "הוראה", "מורה", "לימוד", "education", "tutor", "teaching"],
    starters: [
      {
        name: "תלמיד",
        canonicalKey: "pe:education:student",
        suggestedRequirements: [
          { name: "תעודת זהות הורה/אפוטרופוס", defaultChecked: true },
          { name: "טופס הרשמה", defaultChecked: true },
          { name: "אישור תשלום", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["בני", "קבלנ", "שיפוצ", "construction", "contractor", "renovation"],
    starters: [
      {
        name: "לקוח פרויקט",
        canonicalKey: "pe:construction:project_client",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "הסכם התקשרות", defaultChecked: true },
          { name: "היתר בנייה", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["רכב", "מוסך", "automotive", "garage", "car"],
    starters: [
      {
        name: "לקוח מוסך",
        canonicalKey: "pe:automotive:client",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "רישיון רכב", defaultChecked: true },
          { name: "חשבונית קודמת", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["הייטק", "תוכנה", "מחשוב", "אתרים", "אפליקצי", "software", "tech", "it ", "developer"],
    starters: [
      {
        name: "לקוח שירותי טכנולוגיה",
        canonicalKey: "pe:tech:client",
        suggestedRequirements: [
          { name: "הסכם התקשרות", defaultChecked: true },
          { name: "פרטי גישה / התחברות", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["חנות", "קמעונ", "מסחר", "retail", "store", "shop"],
    starters: [
      {
        name: "לקוח",
        canonicalKey: "pe:retail:client",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "חשבונית רכישה", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["וטרינר", "חיות מחמד", "veterinary", "vet ", "pet"],
    starters: [
      {
        name: "בעל/ת חיית מחמד",
        canonicalKey: "pe:veterinary:pet_owner",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "פנקס חיסונים", defaultChecked: true },
          { name: "טופס הסכמה לטיפול", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["אדריכל", "עיצוב פנים", "architecture", "interior design"],
    starters: [
      {
        name: "לקוח פרויקט",
        canonicalKey: "pe:architecture:project_client",
        suggestedRequirements: [
          { name: "הסכם שכר טרחה", defaultChecked: true },
          { name: "היתר / תוכניות", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["תיירות", "נסיעות", "טיולים", "travel", "tourism"],
    starters: [
      {
        name: "לקוח נסיעות",
        canonicalKey: "pe:travel:client",
        suggestedRequirements: [
          { name: "תעודת זהות", defaultChecked: true },
          { name: "דרכון", defaultChecked: true },
          { name: "טופס הזמנה", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["כושר", "מאמן אישי", "חדר כושר", "fitness", "gym", "personal training"],
    starters: [
      {
        name: "מתאמן",
        canonicalKey: "pe:fitness:trainee",
        suggestedRequirements: [
          { name: "טופס הצטרפות", defaultChecked: true },
          { name: "הצהרת בריאות", defaultChecked: true },
        ],
      },
    ],
  },
  {
    keywords: ["הפקת אירועים", "אירועים", "event planning", "events"],
    starters: [
      {
        name: "לקוח אירוע",
        canonicalKey: "pe:events:client",
        suggestedRequirements: [
          { name: "הסכם התקשרות", defaultChecked: true },
          { name: "פרטי האירוע", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["יופי", "קוסמטיקה", "טיפוח", "מספרה", "beauty", "salon", "cosmetics"],
    starters: [
      {
        name: "לקוח",
        canonicalKey: "pe:beauty:client",
        suggestedRequirements: [
          { name: "טופס הצטרפות", defaultChecked: true },
          { name: "הצהרת בריאות", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["מסעד", "קייטרינג", "אירוח", "food", "restaurant", "catering", "hospitality"],
    starters: [
      {
        name: "לקוח / ספק",
        canonicalKey: "pe:hospitality:client",
        suggestedRequirements: [
          { name: "תעודת עוסק", defaultChecked: true },
          { name: "הסכם התקשרות", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["ניקיון", "אחזקה", "cleaning", "maintenance"],
    starters: [
      {
        name: "לקוח שירות",
        canonicalKey: "pe:cleaning:client",
        suggestedRequirements: [
          { name: "הסכם התקשרות", defaultChecked: true },
          { name: "כתובת ופרטי גישה", defaultChecked: false },
        ],
      },
    ],
  },
  {
    keywords: ["צילום", "יצירה", "אמנות", "photography", "creative", "art"],
    starters: [
      {
        name: "לקוח",
        canonicalKey: "pe:creative:client",
        suggestedRequirements: [
          { name: "הסכם התקשרות", defaultChecked: true },
          { name: "אישור שימוש בתמונות/יצירה", defaultChecked: false },
        ],
      },
    ],
  },
];

// Deterministic longest-match-first, same principle as
// businessTypeClassifier.ts's FLAT_SYNONYMS — a specific phrase should win
// over a coincidental short substring.
function matchKeywordDomain(label: string): StarterBusinessType[] | null {
  const normalized = normalize(label);
  if (!normalized) return null;

  const flat = KEYWORD_DOMAINS.flatMap((domain) =>
    domain.keywords.map((keyword) => ({ keyword: normalize(keyword), starters: domain.starters }))
  ).sort((a, b) => b.keyword.length - a.keyword.length);

  for (const { keyword, starters } of flat) {
    if (normalized.includes(keyword)) return starters;
  }
  return null;
}

// Last resort — only reached when the label matched none of the ~20
// recognized domains above. Never a bare "Unknown"/"General" placeholder:
// the starter type is named directly after the office's own words, so the
// result always reads as specific to what was typed, even though the
// document checklist itself is a safe, broadly-applicable default (proof
// of identity, a signed agreement, proof of address, a payment record) —
// close to universally relevant for a client-facing business of any kind.
function fallbackForLabel(label: string | null | undefined): StarterBusinessType[] {
  const trimmedLabel = label?.trim();
  const displayName = trimmedLabel ? `לקוחות ${trimmedLabel}` : "לקוחות";
  const key = trimmedLabel ? `pe:other:${slugify(trimmedLabel)}` : "pe:other:general";

  return [
    {
      name: displayName,
      canonicalKey: key,
      suggestedRequirements: [
        { name: "תעודת זהות", defaultChecked: true },
        { name: "הסכם / חוזה התקשרות חתום", defaultChecked: true },
        { name: "אישור כתובת", defaultChecked: false },
        { name: "אסמכתת תשלום / חשבונית", defaultChecked: false },
      ],
    },
  ];
}

export async function suggestStarterBusinessTypes(
  businessCategory: string,
  businessCategoryCustomLabel?: string | null
): Promise<StarterBusinessType[]> {
  const preset = PRESET_STARTERS[businessCategory];
  if (preset) return preset;

  // "other" (or any unrecognized value — defensive, Centro never fails
  // here) — try the broader keyword dictionary against the free-text
  // label first, then the label-derived fallback.
  const label = businessCategoryCustomLabel ?? "";
  const matched = matchKeywordDomain(label);
  if (matched) return matched;

  return fallbackForLabel(label);
}
