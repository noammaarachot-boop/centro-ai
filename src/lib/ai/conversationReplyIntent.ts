import { generateObject } from "ai";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";

/**
 * Free-text understanding beyond the deterministic YES_WORDS/NO_WORDS
 * leading-word check (pendingConfirmations.ts's parseConfirmationReply) —
 * a client answering a yes/no confirmation in their own natural words
 * ("זה של אשתי", "שלחתי בטעות", "תתעלם מזה", "זה מסמך נוסף") never leads
 * with a literal "כן"/"לא", so the deterministic check alone always left
 * it "unclear" for a human to resolve manually. This is the AI fallback —
 * only ever consulted once the deterministic check has already failed
 * (see resolveConfirmationFromReply in pendingConfirmations.ts), same
 * layered "deterministic first, AI as enhancement" pattern as
 * documentClassifier.ts's classifyDocumentWithLearning.
 *
 * Never throws and never guesses: any failure (no provider configured, API
 * error, timeout, low model confidence) resolves to "unclear", the exact
 * same outcome as before this fallback existed — a human still resolves it
 * manually via respondToPendingConfirmationManually. This module can only
 * ever turn an "unclear" into a confident "yes"/"no"; it never overrides a
 * deterministic "yes"/"no" the leading-word check already found.
 */

const MIN_CONFIDENCE = 0.75;

export async function classifyYesNoReply(question: string, replyText: string): Promise<"yes" | "no" | "unclear"> {
  const trimmed = replyText.trim();
  if (!trimmed) return "unclear";

  try {
    const model = await resolveLanguageModel();

    const schema = z.object({
      intent: z
        .enum(["yes", "no", "unclear"])
        .describe(
          'האם תשובת הלקוח מהווה אישור ("כן, זה נכון/בכוונה") או דחייה ("לא, זה לא שלי/בטעות/תתעלמו") לשאלה שנשאלה. "unclear" אם באמת אי אפשר לדעת מהניסוח.'
        ),
      confidence: z.number().min(0).max(1).describe("רמת ביטחון בסיווג intent שלמעלה."),
    });

    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `Centro (מערכת לאיסוף מסמכים) שאלה לקוח: "${question}"\n\nהלקוח ענה בהודעת טקסט חופשית: "${trimmed}"\n\nהאם התשובה מהווה אישור (כן) או דחייה (לא) לשאלה? לדוגמה, "זה של אשתי" או "שלחתי בטעות" או "תתעלמו מזה" הם כולם דחייה (לא, לא התכוונתי). "כן זה שלי" או "זה מסמך נוסף שרציתי לצרף" הם אישור (כן). אם התשובה לא עונה בבירור על השאלה, סמן unclear — לעולם אל תנחש.`,
        },
      ],
    });

    if (object.confidence < MIN_CONFIDENCE) return "unclear";
    return object.intent;
  } catch (error) {
    console.error("[conversation-reply-intent] classification failed (falling back to unclear)", error);
    return "unclear";
  }
}

/**
 * Free-text "I'll send it later" understanding — used only when there is
 * no open confirmation for the conversation (see the webhook route /
 * simulateInboundMessage), so this never competes with the yes/no fallback
 * above. Detects a stated intent to send more documents later ("אשלח
 * בערב", "בעוד שעה", "מחר") and estimates how long to actually wait before
 * the next automated reminder — see nextBusinessOpenTime's own reasoning
 * in businessHours.ts for why a reminder must never go out before a time
 * the client explicitly committed to.
 *
 * Never guesses a delay: a message that isn't really a send-later promise,
 * or one the model can't confidently translate into an approximate delay,
 * resolves to isFollowUpPromise:false — normal reminder timing applies,
 * completely unaffected.
 */
export interface FollowUpIntentResult {
  isFollowUpPromise: boolean;
  // Approximate wait before the next reminder, in minutes — null unless
  // isFollowUpPromise is true.
  approxDelayMinutes: number | null;
}

export async function classifyFollowUpIntent(replyText: string): Promise<FollowUpIntentResult> {
  const trimmed = replyText.trim();
  if (!trimmed) return { isFollowUpPromise: false, approxDelayMinutes: null };

  try {
    const model = await resolveLanguageModel();

    const schema = z.object({
      isFollowUpPromise: z
        .boolean()
        .describe('true רק אם ההודעה היא הבטחה ברורה לשלוח עוד מסמכים מאוחר יותר (למשל "אשלח בערב", "בעוד שעה", "מחר בבוקר"). false לכל דבר אחר.'),
      approxDelayMinutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24 * 14)
        .nullable()
        .describe("הערכה גסה, בדקות, מתי הלקוח התכוון לשלוח (למשל \"בעוד שעה\" = 60, \"בערב\" = כ-240, \"מחר\" = כ-1080). null אם isFollowUpPromise הוא false."),
    });

    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח את ההודעה הבאה: "${trimmed}"\n\nהאם זו הבטחה לשלוח עוד מסמכים מאוחר יותר? אם כן, כמה זמן בערך (בדקות) עד שהוא מתכוון לשלוח? אל תנחש אם ההודעה לא ברורה — סמן isFollowUpPromise כ-false.`,
        },
      ],
    });

    if (!object.isFollowUpPromise || object.approxDelayMinutes === null) {
      return { isFollowUpPromise: false, approxDelayMinutes: null };
    }
    return { isFollowUpPromise: true, approxDelayMinutes: object.approxDelayMinutes };
  } catch (error) {
    console.error("[conversation-reply-intent] follow-up classification failed (ignored)", error);
    return { isFollowUpPromise: false, approxDelayMinutes: null };
  }
}
