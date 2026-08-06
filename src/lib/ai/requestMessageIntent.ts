import { generateObject } from "ai";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";

/**
 * Message relevance gate — Centro is not a general chatbot, but it must
 * answer questions that are directly about the client's own active document
 * request ("איזה תלושים אני צריך לשלוח?", "כמה מסמכים חסרים?"), and must
 * recognize the one client-side exception that needs an office employee's
 * decision ("אין לי את המסמך הזה"). Everything else — small talk, unrelated
 * business questions — stays completely silent (see the webhook route,
 * which only ever reaches this classifier once every earlier resolver in
 * the chain — open confirmations, "finished", "I'll send it later" — has
 * already had its chance and found nothing to claim).
 *
 * Never invents an answer here: this module only classifies *which kind* of
 * message this is. The actual answer content always comes from
 * src/lib/requestQnA.ts's deterministic renderers, built from exactly what
 * the office user defined in the requirement — never from anything the
 * model generates freely.
 */

export type RequestMessageCategory =
  // "what do I need to send" / "how many are missing" / "what's still
  // outstanding" / "what did you ask me for" — all answered by the same
  // full-status rendering (src/lib/requestQnA.ts's renderOverviewAnswer).
  | "request_overview"
  // "did you receive what I sent?"
  | "receipt_check"
  // "do I also need an appendix/ספח?"
  | "supporting_document"
  // "can I send a PDF?" / "what file types are ok?"
  | "file_format"
  // The client explicitly says they don't have / can't get a required
  // document — never resolved automatically; routed to an office
  // employee's decision (src/lib/requirementException.ts).
  | "no_document_exception"
  // Anything not about the active document request at all — Centro stays
  // silent (the safe default whenever the model isn't confident either).
  | "unrelated";

export interface RequestMessageIntentResult {
  category: RequestMessageCategory;
  // Only meaningful for "no_document_exception" — the client's own free-text
  // description of which document they mean (e.g. "אישור שכירות"), used to
  // match against the request's currently outstanding requirements. Null
  // whenever the message didn't name one, or for any other category.
  mentionedDocumentType: string | null;
}

const UNRELATED_RESULT: RequestMessageIntentResult = { category: "unrelated", mentionedDocumentType: null };

const schema = z.object({
  category: z
    .enum([
      "request_overview",
      "receipt_check",
      "supporting_document",
      "file_format",
      "no_document_exception",
      "unrelated",
    ])
    .describe(
      '"request_overview" לשאלות כמו "איזה מסמכים אני צריך לשלוח?", "כמה חסר לי?", "מה עדיין חסר?", "מה בדיוק ביקשתם ממני?". ' +
        '"receipt_check" לשאלות כמו "האם המסמך שלחתי התקבל?". ' +
        '"supporting_document" לשאלות כמו "האם צריך גם ספח?". ' +
        '"file_format" לשאלות כמו "אפשר לשלוח PDF?", "באיזה פורמט לשלוח?". ' +
        '"no_document_exception" רק אם הלקוח אומר בבירור שאין לו/אינו יכול להשיג מסמך נדרש (למשל "אין לי את זה", "לא מצליח להשיג את המסמך הזה", "המסמך הזה לא קיים אצלי"). ' +
        '"unrelated" לכל הודעה שאינה שאלה או הצהרה ברורה על בקשת המסמכים הפעילה (שיחת חולין, שאלות עסקיות כלליות, בקשה לשוחח עם נציג וכו׳) — אל תנחש, ברירת המחדל היא unrelated.'
    ),
  mentionedDocumentType: z
    .string()
    .nullable()
    .describe(
      'רק כאשר category הוא "no_document_exception": איזה מסמך בדיוק הלקוח ציין שאין לו, בניסוח קצר (למשל "אישור שכירות"). null אם לא צוין מסמך ספציפי או category אחר.'
    ),
});

// Never throws and never guesses: any failure (no provider configured, API
// error, low confidence) resolves to "unrelated" — the exact same safe
// default as a message that genuinely has nothing to do with the request.
// Centro would rather silently under-respond than misfire.
export async function classifyRequestMessageIntent(
  text: string,
  requirementNames: string[]
): Promise<RequestMessageIntentResult> {
  const trimmed = text.trim();
  if (!trimmed) return UNRELATED_RESULT;

  try {
    const model = await resolveLanguageModel();
    const requirementsLine =
      requirementNames.length > 0 ? `\n\nהדרישות הפתוחות בבקשה הזו כרגע: ${requirementNames.join(", ")}.` : "";

    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: `לקוח של Centro (מערכת לאיסוף מסמכים למשרד) שלח את ההודעה הבאה במהלך בקשת מסמכים פעילה: "${trimmed}"${requirementsLine}\n\nסווג את ההודעה. Centro עונה רק על שאלות שקשורות ישירות לבקשת המסמכים הזו — אל תנחש קטגוריה אם ההודעה לא ברורה, סמן unrelated.`,
        },
      ],
    });

    return { category: object.category, mentionedDocumentType: object.mentionedDocumentType };
  } catch (error) {
    console.error("[request-message-intent] classification failed (falling back to unrelated — stays silent)", error);
    return UNRELATED_RESULT;
  }
}
