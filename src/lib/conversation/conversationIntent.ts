import { generateObject } from "ai";
import { withAiOperation } from "@/lib/aiCore/telemetry/context";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import type { ConversationContext } from "@/lib/conversation/conversationContext";
import type { CorrectionDesiredOutcome } from "@/lib/correction/correctionClassifier";

/**
 * The unified document-conversation understanding layer — the single
 * classifier every inbound client text message goes through FIRST, with
 * full context, before any pending-confirmation/clarification resolution
 * or any other decision runs. Replaces the old ladder's rigid ordering
 * (where an open pending question could resolve — and terminate — a
 * message regardless of its actual meaning, before any real understanding
 * ever happened).
 *
 * Scoped strictly to the document-collection domain: the schema has no
 * "general chat" category at all. "unrelated" is the safe default for
 * anything not about documents/requirements for this active request —
 * never a guess, mirroring classifyRequestMessageIntent's own discipline.
 *
 * Every mutating field (correctionTargetId, etc.) must be validated by the
 * caller against real, already-known candidates — this classifier never
 * has DB write access and never invents an id.
 */

export type ConversationIntentKind =
  | "resolves_pending"
  | "corrects_resolved"
  | "reports_missing_document"
  | "needs_employee_review"
  | "resolves_review_item"
  | "asks_document_question"
  | "finished_signal"
  | "deferral_promise"
  | "unclear"
  | "unrelated";

export type DocumentQuestionCategory = "request_overview" | "receipt_check" | "supporting_document" | "file_format";
export type ReviewCategory = "alternative_or_policy_question" | "human_request" | "other";
export type ReviewItemAction = "close_resolved" | "add_context_note";

export interface ConversationIntentResult {
  kind: ConversationIntentKind;
  confidence: number;
  // "resolves_pending" — only meaningful when the open pending item is a
  // plain yes/no kind (not document_clarification, which always just uses
  // the message's own raw text as the answer, no confirm/decline needed).
  pendingAnswer: "confirm" | "decline" | null;
  // "corrects_resolved"
  correctionTargetType: "document" | "confirmation" | null;
  correctionTargetId: string | null;
  correctionDesiredOutcome: CorrectionDesiredOutcome | null;
  // "reports_missing_document" — the client's own description of which
  // document, if named (same role as classifyRequestMessageIntent's old
  // mentionedDocumentType, fed into resolveExceptionTarget).
  missingDocumentMentionedType: string | null;
  // "needs_employee_review" — opens a brand-new review item.
  reviewCategory: ReviewCategory | null;
  reviewGist: string | null;
  // "resolves_review_item" — the message clearly relates to an EXISTING
  // review item shown below (open or recently resolved), either settling
  // it (close_resolved) or adding a relevant detail without settling it
  // (add_context_note). reviewItemTargetId must be copied verbatim from
  // the list — the caller re-validates it, never trusts it blindly.
  // reviewItemReason is the internal audit explanation (never shown to the
  // client verbatim); naturalAcknowledgment is the actual client-facing
  // reply, phrased warmly from the real facts, never inventing new ones.
  reviewItemTargetId: string | null;
  reviewItemAction: ReviewItemAction | null;
  reviewItemReason: string | null;
  naturalAcknowledgment: string | null;
  // "asks_document_question"
  documentQuestionCategory: DocumentQuestionCategory | null;
}

const UNRELATED_RESULT: ConversationIntentResult = {
  kind: "unrelated",
  confidence: 0,
  pendingAnswer: null,
  correctionTargetType: null,
  correctionTargetId: null,
  correctionDesiredOutcome: null,
  missingDocumentMentionedType: null,
  reviewCategory: null,
  reviewGist: null,
  reviewItemTargetId: null,
  reviewItemAction: null,
  reviewItemReason: null,
  naturalAcknowledgment: null,
  documentQuestionCategory: null,
};

const schema = z.object({
  kind: z
    .enum([
      "resolves_pending",
      "corrects_resolved",
      "reports_missing_document",
      "needs_employee_review",
      "resolves_review_item",
      "asks_document_question",
      "finished_signal",
      "deferral_promise",
      "unclear",
      "unrelated",
    ])
    .describe(
      '"resolves_pending" — ההודעה עונה על השאלה הפתוחה המוצגת למטה (בכל ניסוח, לא רק "כן"/"לא" מילוליים) — כולל מקרה שבו השאלה הפתוחה היא בקשת הבהרה חופשית על מסמך, ואז כל תיאור של הלקוח נחשב תשובה. שימי לב: אם ההודעה בבירור אינה מתייחסת לשאלה הפתוחה אלא שואלת משהו אחר לגמרי, אל תסמני resolves_pending — סמני את הקטגוריה האמיתית (למשל needs_employee_review). ' +
        '"corrects_resolved" — ההודעה מתייחסת למסמך/החלטה שכבר טופלו (מהרשימה למטה) ומבקשת לשנות את התוצאה שלהם. ' +
        '"reports_missing_document" — הלקוח אומר בבירור שאין לו/לא משיג מסמך נדרש. ' +
        '"needs_employee_review" — שאלה חדשה, שאינה מתייחסת לאף אחד מ"הפריטים לבדיקת עובד" המוצגים למטה, הקשורה למסמך/לדרישה בבקשה הזו ואינה נענית מהעובדות הידועות (למשל: אפשר לשלוח מסמך חלופי, המסמך על שם קרוב משפחה, יש רק תמונה של עמוד אחד, המסמך עדיין בתוקף, בקשה לדבר עם נציג אנושי). אל תנחשי — אם לא בטוחה אם השאלה שייכת כאן, סמני needs_employee_review ולא unrelated. ' +
        '"resolves_review_item" — ההודעה מתייחסת באופן ברור לאחד מ"הפריטים לבדיקת עובד" המוצגים למטה (פתוח או שנפתר לאחרונה) — למשל הלקוח מצא את המסמך שהשאלה הייתה עליו, חזר בו, הוסיף פרט רלוונטי, או אמר שהשאלה כבר לא רלוונטית. סמני kind זה גם אם רק חלק מהפריט מתעדכן (add_context_note) וגם אם הוא נפתר לגמרי (close_resolved) — ההבדל נקבע בשדה reviewItemAction. ' +
        '"asks_document_question" — שאלות עובדתיות שהמערכת יודעת לענות עליהן מהנתונים הידועים: מה נדרש/מה חסר, האם מסמך התקבל, האם צריך ספח, באיזה פורמט לשלוח. ' +
        '"finished_signal" — הלקוח אומר בבירור שסיים לשלוח את כל המסמכים. ' +
        '"deferral_promise" — הלקוח מבטיח לשלוח בעתיד (מתוארך או כללי). ' +
        '"unclear" — נראה קשור לבקשת המסמכים אך לא ברור בדיוק למה הלקוח מתכוון או מה הוא רוצה. ' +
        '"unrelated" — לכל הודעה שאינה קשורה כלל לבקשת המסמכים הפעילה (שיחת חולין, נושא עסקי כללי וכו׳) — ברירת המחדל, אל תנחשי.'
    ),
  confidence: z.number().min(0).max(1).describe("רמת ביטחון בסיווג, 0 עד 1. השתמשי בערך נמוך כשאינך בטוחה."),
  pendingAnswer: z
    .enum(["confirm", "decline"])
    .nullable()
    .describe('רק כאשר kind הוא "resolves_pending" והשאלה הפתוחה היא שאלת כן/לא (לא הבהרה חופשית): האם ההודעה מאשרת או דוחה.'),
  correctionTargetType: z
    .enum(["document", "confirmation"])
    .nullable()
    .describe('רק כאשר kind הוא "corrects_resolved": האם ההודעה מתייחסת למסמך או להחלטה מהרשימה.'),
  correctionTargetId: z
    .string()
    .nullable()
    .describe('רק כאשר kind הוא "corrects_resolved": ה-id המדויק מהרשימה למטה. לעולם אל תמציאי id.'),
  correctionDesiredOutcome: z
    .enum(["attach_to_requirement", "save_as_extra", "mark_withdrawn"])
    .nullable()
    .describe('רק כאשר kind הוא "corrects_resolved": מה הלקוח רוצה לגבי המסמך.'),
  missingDocumentMentionedType: z
    .string()
    .nullable()
    .describe('רק כאשר kind הוא "reports_missing_document": איזה מסמך בדיוק הלקוח ציין שאין לו, בניסוח קצר. null אם לא צוין.'),
  reviewCategory: z
    .enum(["alternative_or_policy_question", "human_request", "other"])
    .nullable()
    .describe('רק כאשר kind הוא "needs_employee_review": "human_request" אם הלקוח מבקש לדבר עם אדם, "alternative_or_policy_question" לשאלת מדיניות/חלופה, "other" לכל דבר אחר.'),
  reviewGist: z
    .string()
    .nullable()
    .describe('רק כאשר kind הוא "needs_employee_review": תקציר קצר וברור של השאלה עבור העובד, בעברית.'),
  reviewItemTargetId: z
    .string()
    .nullable()
    .describe(
      'רק כאשר kind הוא "resolves_review_item": ה-id המדויק (חייב להיות זהה בדיוק לאחד מה-id-ים ברשימת "פריטים לבדיקת עובד" למטה) של הפריט שההודעה מתייחסת אליו. לעולם אל תמציאי id — אם אינך בטוחה לאיזה פריט ההודעה מתייחסת, סמני kind אחר או הורידי את confidence.'
    ),
  reviewItemAction: z
    .enum(["close_resolved", "add_context_note"])
    .nullable()
    .describe(
      'רק כאשר kind הוא "resolves_review_item": "close_resolved" — ההודעה פותרת את הפריט באופן חד-משמעי ואין עוד צורך בהחלטת משרד (למשל הלקוח מצא את המסמך המקורי וישלח אותו, או חזר בו לגמרי מהשאלה). "add_context_note" — ההודעה מוסיפה מידע רלוונטי לפריט אך אינה פותרת אותו באופן ודאי (עדיין נדרשת החלטת עובד, או שאין ביטחון מלא שזה נגמר). כשיש ספק כלשהו אם זה נפתר לגמרי — תמיד add_context_note, לעולם אל תנחשי close_resolved.'
    ),
  reviewItemReason: z
    .string()
    .nullable()
    .describe(
      'רק כאשר kind הוא "resolves_review_item": הסבר פנימי קצר וברור בעברית לצוות/לביקורת — למה סומן close_resolved או מה בדיוק ההודעה הוסיפה ל-add_context_note. לעולם אינו נשלח ללקוח.'
    ),
  naturalAcknowledgment: z
    .string()
    .nullable()
    .describe(
      'רק כאשר kind הוא "resolves_review_item": תגובה טבעית, קצרה וחמה ללקוח בעברית, המתאימה בדיוק למצב (למשל "מעולה, אפשר לשלוח אותה כאן" אם מצא את המסמך, או "תודה, רשמתי את זה" להוספת פרט) — התבססי אך ורק על מה שההודעה עצמה אמרה, לעולם אל תמציאי עובדות או החלטות חדשות.'
    ),
  documentQuestionCategory: z
    .enum(["request_overview", "receipt_check", "supporting_document", "file_format"])
    .nullable()
    .describe('רק כאשר kind הוא "asks_document_question": "request_overview" למה נדרש/מה חסר, "receipt_check" האם מסמך התקבל, "supporting_document" האם צריך ספח, "file_format" באיזה פורמט לשלוח.'),
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
    .map((c) => `[id=${c.id}] שאלה: "${c.question}" — הלקוח ענה: ${c.resolvedAnswer === "confirmed" ? "כן" : "לא"}`)
    .join("\n");
}

function formatRecentMessages(context: ConversationContext): string {
  if (context.recentMessages.length === 0) return "אין הודעות קודמות.";
  return context.recentMessages.map((m) => `${m.direction === "inbound" ? "לקוח" : "Centro"}: "${m.body}"`).join("\n");
}

function formatReviewItems(context: ConversationContext): string {
  if (context.reviewItems.length === 0) return "אין פריטים לבדיקת עובד.";
  return context.reviewItems
    .map((r) => `[id=${r.id}] (${r.status === "pending" ? "ממתין להחלטת משרד" : "כבר נענה"}) שאלת הלקוח: "${r.clientQuestion}"${r.gist ? ` — תקציר: ${r.gist}` : ""}`)
    .join("\n");
}

export async function classifyConversationIntent(context: ConversationContext, messageText: string): Promise<ConversationIntentResult> {
  const trimmed = messageText.trim();
  if (!trimmed) return UNRELATED_RESULT;

  try {
    const model = await resolveLanguageModel();
    const openQuestionLine = context.openQuestion
      ? `שאלה פתוחה שממתינה לתשובה כרגע (סוג: ${context.openQuestion.kind}): "${context.openQuestion.question}"`
      : "אין כרגע שאלה פתוחה.";
    const requirementsLine =
      context.requirementFacts.length > 0
        ? `הדרישות בבקשה כרגע: ${context.requirementFacts.map((f) => `${f.description}${f.satisfied ? " (התקבל)" : " (חסר)"}`).join(", ")}.`
        : "";

    const { object } = await withAiOperation("conversation.classify_intent", () =>
      generateObject({
        model,
        schema,
        messages: [
          {
            role: "user",
            content: [
              "לקוח של Centro (מערכת לאיסוף מסמכים למשרד, בוואטסאפ) שלח הודעה חדשה. המטרה: להבין את כוונת הלקוח מתוך ההקשר המלא — לא לפי מילות מפתח קבועות. Centro עוסק אך ורק בתחום המסמכים והדרישות של הבקשה הפעילה — לעולם אינו chatbot כללי.",
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
              "פריטים לבדיקת עובד (פתוחים ושנפתרו לאחרונה) — שאלות של הלקוח שהועברו למשרד:",
              formatReviewItems(context),
              "",
              `ההודעה החדשה מהלקוח: "${trimmed}"`,
              "",
              "סווגי את ההודעה. אל תנחשי — אם לא בטוחה, סמני unclear או הורידי את confidence.",
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
      pendingAnswer: object.pendingAnswer,
      correctionTargetType: object.correctionTargetType,
      correctionTargetId: object.correctionTargetId,
      correctionDesiredOutcome: object.correctionDesiredOutcome,
      missingDocumentMentionedType: object.missingDocumentMentionedType,
      reviewCategory: object.reviewCategory,
      reviewGist: object.reviewGist,
      reviewItemTargetId: object.reviewItemTargetId,
      reviewItemAction: object.reviewItemAction,
      reviewItemReason: object.reviewItemReason,
      naturalAcknowledgment: object.naturalAcknowledgment,
      documentQuestionCategory: object.documentQuestionCategory,
    };
  } catch (error) {
    console.error("[conversation-intent] classification failed (falling back to unrelated)", error);
    return UNRELATED_RESULT;
  }
}
