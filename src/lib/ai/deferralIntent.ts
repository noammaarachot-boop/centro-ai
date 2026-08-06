import { generateObject } from "ai";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";

/**
 * Reminder deferral by explicit client commitment — "אשלח ביום חמישי",
 * "אני בחו״ל, אשלח עוד יומיים", "אשלח שבוע הבא", "אשלח בתאריך 15 באוגוסט"
 * all commit to a real future date, and reminders must genuinely wait for
 * it (never nag in between). This is a materially different, stronger
 * promise than a vague short-term one ("אשלח בערב", "אשלח מאוחר יותר") —
 * see caseReview.ts's own doc comment on why those two stay handled
 * completely differently.
 *
 * Same "AI extracts structure, code computes the actual date" split as
 * every other classifier in this codebase (requirementSemantics.ts,
 * documentClassifier.ts): the model is never trusted to do date arithmetic
 * itself (unreliable and untestable) — it only identifies *which* dating
 * concept the client used; src/lib/reminderDeferral.ts's resolveDeferralDate
 * is the single deterministic place that turns that into a real instant.
 *
 * Deliberately narrow: this classifier only ever distinguishes "a real
 * dated commitment" from "not one" — it never tries to also recognize a
 * vague short-term promise ("אשלח בערב") itself. That's still
 * classifyFollowUpIntent's (conversationReplyIntent.ts) job, called
 * separately by caseReview.ts's applyFollowUpPromiseIfAny once this
 * classifier has already had first look and found no real date — two
 * independent, single-purpose classifiers instead of one that tries to do
 * both and risks conflating them.
 */

export type DeferralHebrewWeekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export type DeferralNamedPeriod = "start_of_next_week" | "end_of_week" | "start_of_month" | "end_of_month";

export interface DeferralDateHint {
  explicitDay: number | null;
  explicitMonth: number | null;
  explicitYear: number | null;
  weekday: DeferralHebrewWeekday | null;
  relativeDays: number | null;
  relativeWeeks: number | null;
  namedPeriod: DeferralNamedPeriod | null;
}

export type DeferralIntentResult =
  // Not a real dated commitment — could be unrelated, could be a vague
  // short-term promise ("אשלח בערב"); either way, this classifier has
  // nothing to add and the caller falls through to its next check.
  | { kind: "not_dated" }
  // A genuine commitment to a specific future date, extracted into
  // dateHint for resolveDeferralDate to turn into a real instant.
  | { kind: "scheduled"; dateHint: DeferralDateHint }
  // Clearly a dated promise, but the model couldn't confidently extract
  // which date — never guessed; the caller asks a short clarifying
  // question instead.
  | { kind: "ambiguous" };

const NOT_DATED_RESULT: DeferralIntentResult = { kind: "not_dated" };

// Rich guidance (not a keyword/regex list — the model still does the actual
// language understanding) on the specific failure mode found via live
// production testing: a real dated commitment phrased as a question
// ("אני יכול לשלוח מחר?") or otherwise indirectly was misclassified as
// "ambiguous" purely because it wasn't a flat declarative statement. The
// fix is prompt-level, not code-level — teaching the model that a question
// proposing a date IS the date commitment, not a separate uncertainty.
const CLASSIFICATION_GUIDANCE = `
הנחיות לסיווג (חשוב במיוחד): כוונת דחייה יכולה להיות מנוסחת בכל צורה טבעית — הצהרה, שאלה, קיצור, סלנג — לא רק "אשלח ב-X". שאלה שמציעה מועד ("אני יכול לשלוח מחר?", "אפשר ביום חמישי?", "אולי שבוע הבא?") שקולה להצהרה על אותו מועד ("אשלח מחר") — בהקשר של שיחה על מסמכים חסרים, השאלה עצמה היא ההצעה של הלקוח למועד שבו ישלח, וזה בדיוק סוג המידע ש-"scheduled" נועד לתפוס. אל תסווג שאלה כזו כ-"ambiguous" רק בגלל שהיא מנוסחת כשאלה ולא כהצהרה ישירה, ואל תסווג אותה כ-"not_dated" — יש בה תאריך מפורש וברור.

דוגמאות ל-"scheduled" (כולן שקולות מבחינת המידע התאריכי, גם אם הניסוח שונה): "אשלח מחר", "מחר אשלח", "אני אשלח את זה מחר", "אני יכול לשלוח מחר?", "אפשר מחר?", "סבבה, מחר", "אשלח עוד יומיים", "אפשר בעוד יומיים?", "אשלח ביום חמישי", "אני יכול ביום חמישי?", "תזכיר לי בראשון", "שבוע הבא אשלח", "אפשר שבוע הבא?".

"not_dated" נשאר רק עבור הבטחות מעורפלות ללא שום תאריך אמיתי הניתן לחישוב ("אשלח בערב", "אשלח מאוחר יותר", "אשלח עוד מעט", "אשלח בקרוב") או הודעות שאינן קשורות כלל.

"ambiguous" נשאר רק כאשר באמת אי אפשר לחשב תאריך קונקרטי מהניסוח עצמו — למשל "אשלח כשאחזור" (בלי לציין מתי חוזרים), או תשובה סתומה לגמרי. עצם היותה שאלה, ניסוח לא ישיר, שגיאת כתיב או ניסוח יומיומי/סלנג אינם סיבה לסמן ambiguous — רק היעדר אמיתי של מידע תאריכי בר-חישוב.
`;

const schema = z.object({
  kind: z
    .enum(["not_dated", "scheduled", "ambiguous"])
    .describe(
      '"not_dated" — ההודעה אינה מתחייבת לתאריך עתידי אמיתי וניתן לזיהוי (כולל הבטחות כלליות לטווח קצר בלי תאריך אמיתי, כמו "אשלח בערב", "אשלח מאוחר יותר", "אשלח עוד מעט", "אשלח בקרוב", וכל הודעה שאינה קשורה כלל). ' +
        '"scheduled" — התחייבות או הצעה לתאריך עתידי אמיתי וניתן לזיהוי (יום בשבוע ספציפי, תאריך מפורש, מספר ימים/שבועות, "שבוע הבא", "סוף השבוע", "תחילת/סוף החודש", "מחר", "מחרתיים) — כולל כשזה מנוסח כשאלה ("אני יכול לשלוח מחר?") ולא רק כהצהרה ("אשלח מחר"). ' +
        '"ambiguous" — ברור שזו הבטחה לתאריך עתידי אמיתי, אבל לא ניתן לחשב בביטחון איזה תאריך בדיוק (למשל אין שום רמז תאריכי בר-חישוב). לעולם אל תנחש תאריך — אם לא בטוח, סמן ambiguous. אבל אל תבלבל בין "לא בטוח איזה תאריך" לבין "מנוסח כשאלה" — שאלה עם תאריך מפורש היא scheduled, לא ambiguous.'
    ),
  weekday: z
    .enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])
    .nullable()
    .describe('רק אם קיים "scheduled" ונאמר יום בשבוע ספציפי (למשל "יום חמישי"). null אחרת.'),
  explicitDay: z.number().int().min(1).max(31).nullable().describe('רק אם צוין תאריך מפורש (למשל "15 באוגוסט" -> 15). null אחרת.'),
  explicitMonth: z
    .number()
    .int()
    .min(1)
    .max(12)
    .nullable()
    .describe('רק אם צוין תאריך מפורש עם חודש (למשל "15 באוגוסט" -> 8). null אחרת.'),
  explicitYear: z.number().int().nullable().describe("רק אם צוינה שנה מפורשת. null אחרת (השנה תיגזר אוטומטית)."),
  relativeDays: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('רק אם צוין מספר ימים יחסי (למשל "מחר"=1, "מחרתיים"=2, "עוד יומיים"=2, "בעוד שלושה ימים"=3). null אחרת.'),
  relativeWeeks: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('רק אם צוין מספר שבועות יחסי (למשל "שבוע הבא"=1, "בעוד שבועיים"=2). null אחרת.'),
  namedPeriod: z
    .enum(["start_of_next_week", "end_of_week", "start_of_month", "end_of_month"])
    .nullable()
    .describe(
      'רק אם צוין ביטוי כללי כזה: "תחילת השבוע הבא"=start_of_next_week, "סוף השבוע"=end_of_week, "תחילת החודש" (הבא)=start_of_month, "סוף החודש"=end_of_month. null אחרת.'
    ),
});

// Never throws and never invents a date: any failure (no provider, API
// error) resolves to "not_dated" — the exact same safe fallthrough as a
// message that was never a dated commitment at all, so the caller's next
// check (the existing vague-promise classifier) still gets a chance at it.
export async function classifyDeferralIntent(text: string, referenceDateLabel: string): Promise<DeferralIntentResult> {
  const trimmed = text.trim();
  if (!trimmed) return NOT_DATED_RESULT;

  try {
    const model = await resolveLanguageModel();
    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח את ההודעה הבאה בהקשר של שיחה על מסמכים חסרים שהמשרד ביקש ממנו: "${trimmed}"\n\nהיום (בזמן המקומי של המשרד) הוא: ${referenceDateLabel}.\n${CLASSIFICATION_GUIDANCE}\nהאם ההודעה מתחייבת או מציעה לשלוח מסמכים במועד עתידי אמיתי (יום ספציפי, תאריך, מספר ימים/שבועות)? אם כן, מהו סוג התאריך שצוין? חלץ רק את השדה הרלוונטי — אל תנחש ואל תחשב תאריך בעצמך, רק זהה מה נאמר.`,
        },
      ],
    });

    if (object.kind === "not_dated") return NOT_DATED_RESULT;
    if (object.kind === "ambiguous") return { kind: "ambiguous" };

    const dateHint: DeferralDateHint = {
      explicitDay: object.explicitDay,
      explicitMonth: object.explicitMonth,
      explicitYear: object.explicitYear,
      weekday: object.weekday,
      relativeDays: object.relativeDays,
      relativeWeeks: object.relativeWeeks,
      namedPeriod: object.namedPeriod,
    };
    // The model said "scheduled" but extracted nothing usable — degrade to
    // asking rather than silently falling through as if nothing was said.
    const hasSomething =
      dateHint.explicitDay !== null ||
      dateHint.weekday !== null ||
      dateHint.relativeDays !== null ||
      dateHint.relativeWeeks !== null ||
      dateHint.namedPeriod !== null;
    if (!hasSomething) return { kind: "ambiguous" };

    return { kind: "scheduled", dateHint };
  } catch (error) {
    console.error("[deferral-intent] classification failed (falling back to not_dated)", error);
    return NOT_DATED_RESULT;
  }
}
