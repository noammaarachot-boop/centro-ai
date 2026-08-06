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

const schema = z.object({
  kind: z
    .enum(["not_dated", "scheduled", "ambiguous"])
    .describe(
      '"not_dated" — ההודעה אינה מתחייבת לתאריך עתידי אמיתי וניתן לזיהוי (כולל הבטחות כלליות לטווח קצר בלי תאריך אמיתי, כמו "אשלח בערב", "אשלח מאוחר יותר", "אשלח עוד מעט", "אשלח בקרוב", וכל הודעה שאינה קשורה כלל). ' +
        '"scheduled" — התחייבות לתאריך עתידי אמיתי וניתן לזיהוי (יום בשבוע ספציפי, תאריך מפורש, מספר ימים/שבועות, "שבוע הבא", "סוף השבוע", "תחילת/סוף החודש", "מחר", "מחרתיים"). ' +
        '"ambiguous" — ברור שזו הבטחה לתאריך עתידי אמיתי, אבל לא ניתן לזהות בביטחון איזה תאריך בדיוק. לעולם אל תנחש תאריך — אם לא בטוח, סמן ambiguous.'
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
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח את ההודעה הבאה: "${trimmed}"\n\nהיום (בזמן המקומי של המשרד) הוא: ${referenceDateLabel}.\n\nהאם ההודעה מתחייבת לשלוח מסמכים במועד עתידי אמיתי (יום ספציפי, תאריך, מספר ימים/שבועות)? אם כן, מהו סוג התאריך שצוין? חלץ רק את השדה הרלוונטי — אל תנחש ואל תחשב תאריך בעצמך, רק זהה מה נאמר.`,
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
