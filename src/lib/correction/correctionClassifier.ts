import { generateObject } from "ai";
import { withAiOperation } from "@/lib/aiCore/telemetry/context";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import type { ConversationContext } from "@/lib/conversation/conversationContext";

/**
 * Conversational correction layer — the general context-aware classifier.
 * Given the full picture (open question if any, recent resolved documents/
 * confirmations, recent messages, requirement facts), decides whether a new
 * client message either (a) answers the currently-open question in a
 * non-keyword way, (b) corrects something already resolved, or (c) neither
 * — in which case the caller falls through to the existing deferral/QnA
 * chain, completely unchanged.
 *
 * Never guesses: targetId must be copied verbatim from a candidate id shown
 * in the prompt — the caller validates this against the exact same
 * candidate list the context was built from, in the same call, and treats
 * any mismatch as unclear. Confidence is a plain 0-1 score, the same shape
 * every other classifier in src/lib/ai/ already uses.
 */

export type CorrectionDesiredOutcome = "attach_to_requirement" | "save_as_extra" | "mark_withdrawn";

export interface CorrectionClassificationResult {
  kind: "not_applicable" | "answers_open_question" | "corrects_resolved";
  confidence: number;
  answer: "confirm" | "decline" | null;
  targetType: "document" | "confirmation" | null;
  targetId: string | null;
  desiredOutcome: CorrectionDesiredOutcome | null;
}

const NOT_APPLICABLE_RESULT: CorrectionClassificationResult = {
  kind: "not_applicable",
  confidence: 0,
  answer: null,
  targetType: null,
  targetId: null,
  desiredOutcome: null,
};

const schema = z.object({
  kind: z
    .enum(["not_applicable", "answers_open_question", "corrects_resolved"])
    .describe(
      '"answers_open_question" — ההודעה עונה על השאלה הפתוחה המוצגת למטה (בניסוח שאינו "כן"/"לא" מילולי מובהק). ' +
        '"corrects_resolved" — ההודעה מתייחסת למסמך או להחלטה שכבר טופלו (מהרשימה "החלטות/מסמכים אחרונים" למטה) ומבקשת לשנות את התוצאה שלהם. ' +
        '"not_applicable" — ההודעה אינה תשובה לשאלה הפתוחה ואינה תיקון להחלטה קודמת — ברירת המחדל, אל תנחש.'
    ),
  confidence: z.number().min(0).max(1).describe("רמת ביטחון בסיווג, 0 עד 1. השתמש בערך נמוך כשאינך בטוח."),
  answer: z
    .enum(["confirm", "decline"])
    .nullable()
    .describe('רק כאשר kind הוא "answers_open_question": האם ההודעה מאשרת או דוחה את השאלה הפתוחה.'),
  targetType: z
    .enum(["document", "confirmation"])
    .nullable()
    .describe('רק כאשר kind הוא "corrects_resolved": האם ההודעה מתייחסת למסמך או להחלטה (confirmation) מהרשימה.'),
  targetId: z
    .string()
    .nullable()
    .describe(
      'רק כאשר kind הוא "corrects_resolved": ה-id המדויק (חייב להיות זהה בדיוק לאחד מה-id-ים שהוצגו למטה) של המסמך/ההחלטה שאליה ההודעה מתייחסת. לעולם אל תמציא id — אם אינך בטוח, סמן kind=not_applicable או הורד את confidence.'
    ),
  desiredOutcome: z
    .enum(["attach_to_requirement", "save_as_extra", "mark_withdrawn"])
    .nullable()
    .describe(
      'רק כאשר kind הוא "corrects_resolved": מה הלקוח רוצה עכשיו לגבי המסמך. "attach_to_requirement" — בכל זאת לצרף כמענה לדרישה שהוא הותאם אליה בעבר. "save_as_extra" — לשמור רק כמסמך נוסף, לא כמענה לדרישה. "mark_withdrawn" — לבטל את המסמך לגמרי (לא נשלח בכוונה / טעות).'
    ),
});

function formatCandidateDocuments(context: ConversationContext): string {
  if (context.recentDocuments.length === 0) return "אין מסמכים אחרונים.";
  return context.recentDocuments
    .map((doc, index) => {
      const parts = [
        `[id=${doc.id}]`,
        doc.documentType ?? "מסמך",
        doc.requirementName ? `(מותאם לדרישה: ${doc.requirementName})` : "(לא מותאם לדרישה)",
        doc.extractedPersonName ? `על שם ${doc.extractedPersonName}` : null,
        `סטטוס: ${doc.status}`,
      ].filter(Boolean);
      return `${index === 0 ? "המסמך האחרון" : `לפני כן (${index + 1})`}: ${parts.join(" ")}`;
    })
    .join("\n");
}

function formatCandidateConfirmations(context: ConversationContext): string {
  if (context.recentResolvedConfirmations.length === 0) return "אין החלטות אחרונות.";
  return context.recentResolvedConfirmations
    .map(
      (c) =>
        `[id=${c.id}] שאלה: "${c.question}" — הלקוח ענה: ${c.resolvedAnswer === "confirmed" ? "כן" : "לא"}`
    )
    .join("\n");
}

function formatRecentMessages(context: ConversationContext): string {
  if (context.recentMessages.length === 0) return "אין הודעות קודמות.";
  return context.recentMessages
    .map((m) => `${m.direction === "inbound" ? "לקוח" : "Centro"}: "${m.body}"`)
    .join("\n");
}

export async function classifyCorrectionIntent(
  context: ConversationContext,
  messageText: string
): Promise<CorrectionClassificationResult> {
  const trimmed = messageText.trim();
  if (!trimmed) return NOT_APPLICABLE_RESULT;
  // Nothing at all to be a correction about — skip the AI call entirely.
  if (!context.openQuestion && context.recentDocuments.length === 0 && context.recentResolvedConfirmations.length === 0) {
    return NOT_APPLICABLE_RESULT;
  }

  try {
    const model = await resolveLanguageModel();
    const openQuestionLine = context.openQuestion
      ? `שאלה פתוחה שממתינה לתשובה כרגע: "${context.openQuestion.question}"`
      : "אין כרגע שאלה פתוחה.";
    const requirementsLine =
      context.requirementFacts.length > 0
        ? `הדרישות בבקשה כרגע: ${context.requirementFacts.map((f) => `${f.description}${f.satisfied ? " (התקבל)" : " (חסר)"}`).join(", ")}.`
        : "";

    const { object } = await withAiOperation("correction.classify_intent", () =>
      generateObject({
        model,
        schema,
        messages: [
          {
            role: "user",
            content: [
              "לקוח של Centro (מערכת לאיסוף מסמכים למשרד, בוואטסאפ) שלח הודעה חדשה. המטרה: להבין אם ההודעה עונה על שאלה פתוחה, או מתקנת החלטה שכבר טופלה, מתוך ההקשר המלא — לא לפי מילות מפתח קבועות.",
              "",
              openQuestionLine,
              requirementsLine,
              "",
              "מסמכים אחרונים (מהחדש לישן):",
              formatCandidateDocuments(context),
              "",
              "החלטות אחרונות שכבר נענו (מהחדש לישן):",
              formatCandidateConfirmations(context),
              "",
              "הודעות אחרונות בשיחה:",
              formatRecentMessages(context),
              "",
              `ההודעה החדשה מהלקוח: "${trimmed}"`,
              "",
              "סווג את ההודעה. אם אתה לא בטוח לאיזה מסמך/החלטה ההודעה מתייחסת, או מה בדיוק הלקוח רוצה — סמן kind=not_applicable או הורד את confidence, לעולם אל תנחש.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      })
    );

    return {
      kind: object.kind,
      confidence: object.confidence,
      answer: object.answer,
      targetType: object.targetType,
      targetId: object.targetId,
      desiredOutcome: object.desiredOutcome,
    };
  } catch (error) {
    console.error("[correction] classification failed (falling back to not_applicable)", error);
    return NOT_APPLICABLE_RESULT;
  }
}
