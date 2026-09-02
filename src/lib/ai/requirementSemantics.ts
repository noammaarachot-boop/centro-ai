import { generateObject } from "ai";
import { withAiOperation } from "@/lib/aiCore/telemetry/context";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";

/**
 * Semantic requirement engine — Centro's core rule: "the office user's
 * request is the source of truth." A requirement's free-text name ("3
 * תלושי שכר של 3 החודשים האחרונים") is never reduced to a bare document
 * type + an assumed quantity rule; it's parsed, once, into an explicit
 * structure that src/lib/documentQuantity.ts's computeRequirementSatisfaction
 * actually enforces. The system never invents a rule the office user didn't
 * state — see interpretationConfidence below.
 */

export type PeriodType = "none" | "relative" | "explicit" | "unspecified";

export interface RelativePeriod {
  kind: "last_n_months";
  n: number;
}

export interface RequirementSemanticSpec {
  // The literal free text this was parsed from — kept as the ultimate
  // source of truth alongside the structure (requirement.name already
  // stores this too; duplicated here so the spec is self-contained).
  originalText: string;
  documentType: string;
  requiredCount: number;
  periodType: PeriodType;
  // "MM/YYYY" once resolved (collectionRequestRequirements.semanticSpec —
  // see resolveExplicitPeriodsForSnapshot), or a bare "MM" month-only entry
  // at the reusable-template level (serviceDocumentRequirements.semanticSpec)
  // where no concrete request date exists yet to anchor a year to.
  explicitPeriods: string[] | null;
  relativePeriod: RelativePeriod | null;
  // "3 תלושי שכר של חודש יוני" — all requiredCount documents may share the
  // same period; a duplicate period is expected, not a red flag.
  samePeriodAllowed: boolean;
  // "3 תלושי שכר של 3 החודשים האחרונים" / "ינואר, פברואר, מרץ" — each of
  // the requiredCount documents must cover a different period.
  distinctPeriodsRequired: boolean;
  // "3 תלושי שכר לעובדים שונים" — requiredCount documents must belong to
  // requiredCount visibly-different people (compared via extractedPersonName).
  distinctPeopleRequired: boolean;
  expectedPersonOrCompany: string | null;
  validityRequirement: string | null;
  supportingDocumentRelationship: string | null;
  freeTextConstraints: string | null;
  // 0-1. Below MIN_CONFIDENCE_TO_AUTO_SAVE, the caller must not save this
  // spec silently — see requiresClarification below and
  // src/app/(app)/services/actions.ts's addRequirement.
  interpretationConfidence: number;
  // Populated only when interpretationConfidence is low — the exact short
  // question to ask the OFFICE USER (never the client) before this
  // requirement is actually used to collect documents.
  clarifyingQuestion: string | null;
}

export const MIN_CONFIDENCE_TO_AUTO_SAVE = 0.7;

export function requiresClarification(spec: RequirementSemanticSpec): boolean {
  return spec.interpretationConfidence < MIN_CONFIDENCE_TO_AUTO_SAVE;
}

const schema = z.object({
  documentType: z.string().describe('שם סוג המסמך הבסיסי, נקי, בלי מספרים/תקופות (למשל "תלוש שכר" מתוך "3 תלושי שכר של יוני").'),
  requiredCount: z.number().int().min(1).describe('כמה מסמכים/יחידות נדרשים בפועל. ברירת מחדל 1 אם לא צוין מספר.'),
  periodType: z
    .enum(["none", "relative", "explicit", "unspecified"])
    .describe(
      '"none" אם אין מושג של תקופה כלל (למשל תעודת זהות, חוזה). "relative" אם התקופה יחסית למועד הבקשה (למשל "3 החודשים האחרונים"). "explicit" אם צוינו חודשים/תקופות ספציפיים (למשל "יוני", "ינואר פברואר מרץ"). "unspecified" אם המשתמש ציין כמות (כמו "3 תלושי שכר") בלי לפרש בבירור אם הכוונה לתקופות שונות או לאותה תקופה — זה המקרה שבו האמת תלוי־בפרשנות, וחייבים confidence נמוך.'
    ),
  explicitPeriods: z
    .array(z.string())
    .nullable()
    .describe(
      'רק כאשר periodType הוא "explicit": רשימת החודשים שצוינו, כל אחד כמחרוזת חודש דו-ספרתית "MM" (למשל "06" ליוני). null אחרת.'
    ),
  relativeMonths: z
    .number()
    .int()
    .nullable()
    .describe('רק כאשר periodType הוא "relative": כמה חודשים אחורה (למשל 3 עבור "3 החודשים האחרונים"). null אחרת.'),
  samePeriodAllowed: z
    .boolean()
    .describe('true אם כל המסמכים הנדרשים רשאים להיות מאותה תקופה בדיוק (למשל "3 תלושים של יוני"). false אחרת.'),
  distinctPeriodsRequired: z
    .boolean()
    .describe('true אם כל מסמך חייב להיות מתקופה שונה מהאחרים (למשל "3 חודשים אחרונים", "ינואר פברואר מרץ"). false אחרת.'),
  distinctPeopleRequired: z
    .boolean()
    .describe('true אם המשתמש ציין במפורש שהמסמכים צריכים להיות של אנשים/ישויות שונים (למשל "לעובדים שונים"). false אם לא צוין.'),
  expectedPersonOrCompany: z
    .string()
    .nullable()
    .describe("אם המשתמש ציין בבירור שם אדם/חברה ספציפיים שהמסמך אמור להיות שלהם. null אחרת."),
  validityRequirement: z
    .string()
    .nullable()
    .describe('אם המשתמש ציין דרישת תוקף (למשל "בתוקף", "לא פג תוקף"). null אחרת.'),
  supportingDocumentRelationship: z
    .string()
    .nullable()
    .describe('אם המשתמש רמז על קשר למסמך אחר (למשל "ספח" שצריך להתאים לתעודת זהות). null אחרת.'),
  freeTextConstraints: z
    .string()
    .nullable()
    .describe("כל אילוץ נוסף שהמשתמש ציין ולא נכנס לשדות למעלה. null אם אין."),
  interpretationConfidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "רמת ביטחון שהפרשנות למעלה נכונה. אם יש יותר מדרך סבירה אחת להבין את הבקשה (למשל \"3 תלושי שכר\" בלי לפרש אם הכוונה ל-3 חודשים שונים או אותו חודש) — הביטחון חייב להיות נמוך (מתחת ל-0.7), לעולם אל תמציא כלל שהמשתמש לא כתב בפירוש."
    ),
  clarifyingQuestion: z
    .string()
    .nullable()
    .describe(
      'אם הביטחון נמוך: שאלה קצרה ועדינה למשתמש שיצר את הבקשה (לא ללקוח!) שתבהיר את הכוונה, למשל "רק כדי לוודא: כשכתבת \'3 תלושי שכר\', התכוונת לשלושה חודשים שונים או לשלושה תלושים מאותו חודש?". null אם הביטחון גבוה.'
    ),
});

// Never throws and never silently invents a rule the office user didn't
// state: a provider failure returns a low-confidence "unspecified" spec
// (requiresClarification will be true), the same outcome as genuine model
// uncertainty — the caller must not auto-save either.
export async function parseRequirementSemantics(
  text: string,
  contextRequirementNames: string[] = []
): Promise<RequirementSemanticSpec> {
  const trimmed = text.trim();
  const fallback: RequirementSemanticSpec = {
    originalText: trimmed,
    documentType: trimmed,
    requiredCount: 1,
    periodType: "unspecified",
    explicitPeriods: null,
    relativePeriod: null,
    samePeriodAllowed: false,
    distinctPeriodsRequired: false,
    distinctPeopleRequired: false,
    expectedPersonOrCompany: null,
    validityRequirement: null,
    supportingDocumentRelationship: null,
    freeTextConstraints: null,
    interpretationConfidence: 0,
    clarifyingQuestion: `רק כדי לוודא: מה בדיוק הדרישה עבור "${trimmed}"?`,
  };
  if (!trimmed) return fallback;

  try {
    const model = await resolveLanguageModel();
    const contextLine =
      contextRequirementNames.length > 0
        ? `\n\nדרישות מסמכים נוספות שכבר קיימות באותה בקשה (להקשר בלבד, אל תפרש אותן): ${contextRequirementNames.join(", ")}.`
        : "";

    const { object } = await withAiOperation("requirement.parse_semantics", () =>
      generateObject({
        model,
        schema,
        messages: [
          {
            role: "user",
            content: `משתמש משרד (רואה חשבון/עורך דין) הקליד את הדרישה הבאה עבור בקשת איסוף מסמכים מלקוח: "${trimmed}"${contextLine}\n\nנתח את הדרישה למבנה מדויק. אל תניח כללים שהמשתמש לא כתב בפירוש — אם הניסוח עמום (לדוגמה "3 תלושי שכר" בלי לציין אם הכוונה לחודשים שונים או לאותו חודש), סמן זאת בביטחון נמוך ונסח שאלת הבהרה קצרה במקום לנחש.`,
          },
        ],
      })
    );

    return {
      originalText: trimmed,
      documentType: object.documentType || trimmed,
      requiredCount: object.requiredCount,
      periodType: object.periodType,
      explicitPeriods: object.periodType === "explicit" ? object.explicitPeriods : null,
      relativePeriod:
        object.periodType === "relative" && object.relativeMonths ? { kind: "last_n_months", n: object.relativeMonths } : null,
      samePeriodAllowed: object.samePeriodAllowed,
      distinctPeriodsRequired: object.distinctPeriodsRequired,
      distinctPeopleRequired: object.distinctPeopleRequired,
      expectedPersonOrCompany: object.expectedPersonOrCompany,
      validityRequirement: object.validityRequirement,
      supportingDocumentRelationship: object.supportingDocumentRelationship,
      freeTextConstraints: object.freeTextConstraints,
      interpretationConfidence: object.interpretationConfidence,
      clarifyingQuestion: object.clarifyingQuestion,
    };
  } catch (error) {
    console.error("[requirement-semantics] parsing failed (falling back to low-confidence, clarification required)", error);
    return fallback;
  }
}

// A bare "MM" month-only entry (stored at the reusable-Service-template
// level, where no concrete request date exists yet — see the schema doc
// comment on serviceDocumentRequirements.semanticSpec) only becomes a real
// "MM/YYYY" once a specific Collection Request actually anchors it. Picks
// the most recent occurrence of that month that isn't in the future
// relative to the request's own creation date (a request for "documents
// for June" created in August means this June, not next June).
export function resolveExplicitPeriodsForSnapshot(explicitPeriods: string[] | null, anchorDate: Date): string[] | null {
  if (!explicitPeriods) return null;
  return explicitPeriods.map((entry) => {
    if (/^\d{2}\/\d{4}$/.test(entry)) return entry; // already concrete
    const month = Number.parseInt(entry, 10);
    if (!Number.isInteger(month) || month < 1 || month > 12) return entry; // leave malformed entries untouched, never guess
    const anchorMonth = anchorDate.getMonth() + 1;
    const anchorYear = anchorDate.getFullYear();
    const year = month <= anchorMonth ? anchorYear : anchorYear - 1;
    return `${String(month).padStart(2, "0")}/${year}`;
  });
}
