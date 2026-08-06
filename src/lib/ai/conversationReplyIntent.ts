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
// Deliberately no delay estimation — a client's own inbound message
// already resets conversations.updatedAt (recordInboundMessage), which is
// exactly what the scheduler's stale-conversation reminder measures
// against. A promise like "אשלח בעוד שעה" doesn't need its own precise
// timer: it's never nagged before the regular reminder interval elapses
// either way, and if the request is fully satisfied by the time that
// interval is up, the scheduler completes it instead of reminding at all
// (see runScheduledTasks) — so no reminder ever fires "too early" relative
// to what the client actually said, without needing to parse how early is
// too early.
export async function classifyFollowUpIntent(replyText: string): Promise<boolean> {
  const trimmed = replyText.trim();
  if (!trimmed) return false;

  try {
    const model = await resolveLanguageModel();
    const schema = z.object({
      isFollowUpPromise: z
        .boolean()
        .describe('true רק אם ההודעה היא הבטחה ברורה לשלוח עוד מסמכים מאוחר יותר (למשל "אשלח בערב", "בעוד שעה", "מחר בבוקר"). false לכל דבר אחר.'),
    });
    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח את ההודעה הבאה: "${trimmed}"\n\nהאם זו הבטחה לשלוח עוד מסמכים מאוחר יותר? אל תנחש אם ההודעה לא ברורה — סמן false.`,
        },
      ],
    });
    return object.isFollowUpPromise;
  } catch (error) {
    console.error("[conversation-reply-intent] follow-up classification failed (ignored)", error);
    return false;
  }
}

/**
 * Post-completion intent gate (src/lib/requestReopen.ts) — "Centro only
 * intervenes from when the request is sent until it's finally completed."
 * Once a request has completed, Centro stays completely silent UNLESS the
 * client explicitly references the finished request or a document in it
 * ("שכחתי לשלוח עוד מסמך", "המסמך הקודם היה לא נכון", "זה מסמך מעודכן",
 * "תוסיף גם את הקובץ הזה", "שלחתי עכשיו את החסר") — only then does Centro
 * ask a short reopening confirmation instead of staying silent. Never
 * guesses: a message that doesn't clearly reference the finished
 * request/document resolves to false, and requestReopen.ts stays silent,
 * exactly the safe default this whole gate exists to enforce.
 */
export async function classifyReopenIntent(replyText: string): Promise<boolean> {
  const trimmed = replyText.trim();
  if (!trimmed) return false;

  try {
    const model = await resolveLanguageModel();
    const schema = z.object({
      isReopenIntent: z
        .boolean()
        .describe(
          'true רק אם ההודעה מתייחסת במפורש לבקשת מסמכים שכבר הסתיימה או למסמך שכבר נשלח בה (למשל "שכחתי לשלוח עוד מסמך", "המסמך הקודם היה לא נכון", "זה מסמך מעודכן", "תוסיף גם את הקובץ הזה", "שלחתי עכשיו את החסר"). false לכל הודעה אחרת, כולל שיחת חולין או שאלות כלליות שלא קשורות למסמכים.'
        ),
    });
    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח הודעה לאחר שבקשת המסמכים שלו כבר הסתיימה: "${trimmed}"\n\nהאם ההודעה מתייחסת במפורש לבקשה שהסתיימה או למסמך שכבר נשלח בה (רוצה להוסיף/לתקן/להשלים משהו)? אל תנחש — אם זו הודעה כללית שלא קשורה במפורש למסמכים, סמן false.`,
        },
      ],
    });
    return object.isReopenIntent;
  } catch (error) {
    console.error("[conversation-reply-intent] reopen-intent classification failed (falling back to no intent — stays silent)", error);
    return false;
  }
}

/**
 * Document replace/supersede (src/lib/documentReplace.ts) — a client
 * sending a new document alongside a caption/message like "זה מחליף את
 * הקודם", "תתעלם מהקובץ הקודם", "המסמך הראשון היה לא נכון" means the new
 * file should replace an already-approved one, not add to it. "זה מסמך
 * נוסף", "שניהם נכונים" explicitly mean the opposite — both are real,
 * kept independently. Anything that doesn't clearly say either resolves
 * to "none" — the new document is just classified normally, exactly as if
 * no such message had been sent at all (the default, safe behavior).
 */
export type DocumentRelationIntent = "replace" | "additional" | "none";

export async function classifyDocumentRelationIntent(text: string): Promise<DocumentRelationIntent> {
  const trimmed = text.trim();
  if (!trimmed) return "none";

  try {
    const model = await resolveLanguageModel();
    const schema = z.object({
      relation: z
        .enum(["replace", "additional", "none"])
        .describe(
          '"replace" רק אם ההודעה אומרת בבירור שהמסמך הזה מחליף/מתקן/במקום מסמך קודם (למשל "זה מחליף את הקודם", "תתעלם מהקודם", "המסמך הראשון היה לא נכון", "זה הגרסה הנכונה"). "additional" אם ההודעה אומרת בבירור שזה מסמך נוסף ולא תחליף (למשל "זה מסמך נוסף", "שניהם נכונים"). "none" אם ההודעה לא מתייחסת בבירור ליחס בין המסמך הזה למסמך קודם כלשהו — אל תנחש.'
        ),
    });
    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים) שלח מסמך חדש יחד עם ההודעה: "${trimmed}"\n\nהאם ההודעה אומרת שהמסמך הזה מחליף מסמך קודם, שהוא מסמך נוסף בנפרד, או שאינה מתייחסת ליחס בין מסמכים כלל?`,
        },
      ],
    });
    return object.relation;
  } catch (error) {
    console.error("[conversation-reply-intent] document-relation classification failed (falling back to none — classified normally)", error);
    return "none";
  }
}
