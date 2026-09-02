import { generateObject } from "ai";
import { withAiOperation } from "@/lib/aiCore/telemetry/context";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import type { DocumentClassificationCandidate } from "./documentClassifierTypes";

// Identification (what is this document?) and matching (does it answer one
// of the request's open requirements?) are deliberately two separate
// signals, not one confidence number — a document can be identified with
// total certainty (an invoice) while still matching nothing on the list.
// Conflating them was the original bug: a real production case had the
// model return matchedRequirementName "none" alongside a 0.97 "confidence"
// that actually meant "I'm sure this is an invoice," which downstream code
// read as "0.97 confident it's a match." See resolveDocumentIntakeOutcome
// in src/lib/documentIntakeReview.ts, which is what actually decides
// matched vs unsolicited vs unrecognized from this result.
export interface VisionClassificationResult {
  identified: boolean;
  documentType: string | null;
  identificationConfidence: number;
  matchedRequirementId: string | null;
  matchConfidence: number;
  // Smart identity/consistency verification (documentIdentityVerification.ts)
  // — best-effort extraction of whichever identity fields actually appear
  // on the document (a bank statement has an account holder name but no ID
  // number; a company invoice has a business name but no personal ID;
  // etc). Every field is independently nullable. Never a replacement for
  // identificationConfidence/matchConfidence above — only ever used to
  // compare this document against the client and its sibling documents.
  extractedPersonName: string | null;
  extractedIdNumber: string | null;
  extractedCompanyName: string | null;
  // How much to trust the three fields above (0 when none were visible at
  // all). Deliberately one shared number rather than one per field — the
  // caller's job is deciding whether to trust extraction enough to act on
  // it, not to reason about partial reliability.
  identityExtractionConfidence: number;
  // Quantity-aware requirement engine (src/lib/documentQuantity.ts) — the
  // dated period this document covers ("MM/YYYY"), when the document type
  // has an obvious one (a payslip's own month, a bank statement's own
  // month, an invoice's own date) — null for anything undated or unclear.
  documentPeriodLabel: string | null;
  periodExtractionConfidence: number;
  // Multi-signal multi-page detection (src/lib/documentContinuation.ts) —
  // corroborating signals for "is this another page of a document already
  // received," beyond just arrival timing. All independently nullable —
  // never guessed when not visible.
  documentReferenceNumber: string | null; // a contract/invoice/case number printed on the page, if any
  pageNumberCurrent: number | null; // this page's own number, if printed (e.g. "עמוד 2 מתוך 3" -> 2)
  pageNumberTotal: number | null; // the total page count, if printed (e.g. "עמוד 2 מתוך 3" -> 3)
  // Immediate problematic-document handling — a real image-quality defect
  // (as opposed to "I just don't recognize this kind of document," which
  // identified=false already covers on its own) that makes the file
  // genuinely unusable even if a type/match was otherwise guessed. When
  // set, resolveDocumentIntakeOutcome (documentIntakeReview.ts) always
  // routes to "needs_resend" regardless of how confident the match/identify
  // scores were — a blurry ID card must never be silently auto-approved.
  readabilityIssue: "blurry" | "cropped_or_incomplete" | "too_dark_or_low_quality" | "damaged" | "wrong_orientation" | "other" | null;
  // Free-text elaboration of the issue above, grounded in what's actually
  // visible (e.g. "רק החלק העליון של המסמך נראה בתמונה") — null whenever
  // readabilityIssue is null.
  readabilityIssueDetail: string | null;
  // A hedged guess at the document type, filled in only when identified is
  // false but there's a real partial signal worth mentioning to the client
  // (e.g. "משהו שנראה כמו תעודה רשמית") — never a confident assertion, and
  // null when there's genuinely nothing to go on.
  suspectedDocumentType: string | null;
  // A ready, natural Hebrew message for the client — populated only when
  // this document needs a resend (readabilityIssue is set, or identified is
  // false). Grounded strictly in the fields above: never claims certainty
  // beyond identificationConfidence, always hedges suspectedDocumentType,
  // never invents a readabilityIssue that wasn't actually flagged, and asks
  // for a clear resend rather than a generic "did you mean to send this?".
  // Null whenever the document doesn't need one (it's readable and either
  // matched or a confidently-identified-but-unsolicited type).
  clientMessageIfProblematic: string | null;
}

// WhatsApp never supplies a real filename for an inbound photo (Meta's
// payload for an image message is just a media id — see resolveAttachment
// in src/app/api/webhooks/whatsapp/route.ts), so documentClassifier.ts's
// filename-token heuristic can never score a confident match on one. This
// is the real classification layer for that case: it reads the actual file
// content via a configured multimodal AI provider (reusing aiCore's own
// provider resolution — see resolveModel.ts — rather than a separate
// credential), so it works for any organization that has one of
// OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY set.
//
// Called only when there's real file content to look at (see
// classifyDocumentViaAI in documentClassifier.ts) — filename-only paths
// (the DevTools simulator, addManualDocument without bytes) never reach
// this and keep relying on the deterministic filename heuristic alone,
// exactly as before.
const VISION_SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
]);

export function isVisionClassifiableMimeType(mimeType: string): boolean {
  return VISION_SUPPORTED_MIME_TYPES.has(mimeType);
}

const NONE = "לא ידוע / לא תואם";

// Never throws — any failure (no provider configured, API error, timeout,
// a malformed/unparseable model response) resolves to null, which the
// caller (classifyDocumentViaAI) treats the same as "not identified" —
// a classification outage must never block a document from being received
// and stored (same resilience principle as withRetry/
// uploadDocumentResiliently elsewhere in this pipeline).
export async function classifyDocumentViaVisionAI(
  fileBytes: Buffer,
  mimeType: string,
  candidates: DocumentClassificationCandidate[]
): Promise<VisionClassificationResult | null> {
  if (candidates.length === 0 || !isVisionClassifiableMimeType(mimeType)) {
    return null;
  }

  try {
    const model = await resolveLanguageModel();
    const candidateNames = candidates.map((c) => c.name);

    const schema = z.object({
      identified: z
        .boolean()
        .describe(
          "true אם הצלחת לזהות בבירור איזה סוג מסמך זה בפועל — גם אם הוא לא מתאים לאף אחת מהדרישות ברשימה. false רק אם הקובץ לא ברור, לא קריא, או שלא ניתן לזהות כלל על מה מדובר."
        ),
      documentType: z
        .string()
        .nullable()
        .describe("תיאור קצר בעברית של סוג המסמך בפועל (למשל: תעודת זהות, חשבונית מס, תלוש שכר) — null אם identified=false"),
      identificationConfidence: z
        .number()
        .min(0)
        .max(1)
        .describe("רמת ביטחון בזיהוי סוג המסמך עצמו — לא בהתאמה שלו לדרישה כלשהי"),
      matchedRequirementName: z
        .enum([NONE, ...candidateNames])
        .describe(
          `ההעתקה המדויקת של השם, מתוך רשימת הדרישות שסופקה, שהמסמך הזה עונה עליה בפועל — או "${NONE}" אם המסמך אינו עונה על אף אחת מהן, גם אם זוהה בבירור`
        ),
      matchConfidence: z
        .number()
        .min(0)
        .max(1)
        .describe(`רמת ביטחון שהמסמך עונה על הדרישה שנבחרה — 0 אם matchedRequirementName הוא "${NONE}"`),
      extractedPersonName: z
        .string()
        .nullable()
        .describe(
          "השם המלא של האדם שהמסמך שייך לו/מופיע עליו (בעל תעודת הזהות, בעל חשבון הבנק, העובד בתלוש השכר וכו') — בדיוק כפי שהוא מופיע במסמך. null אם אין שם אדם ברור במסמך (למשל מסמך שמזהה רק חברה)."
        ),
      extractedIdNumber: z
        .string()
        .nullable()
        .describe(
          "מספר תעודת הזהות/דרכון של האדם, ספרות בלבד ללא מקפים או רווחים, בדיוק כפי שמופיע במסמך. null אם אין מספר זהות אישי גלוי במסמך."
        ),
      extractedCompanyName: z
        .string()
        .nullable()
        .describe("שם החברה/העסק שהמסמך שייך לו או מונפק על ידו, אם קיים. null אם אין שם חברה רלוונטי גלוי במסמך."),
      identityExtractionConfidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "רמת ביטחון כללית בשדות הזיהוי שחילצת למעלה (שם/מספר זהות/שם חברה) — 0 אם לא הצלחת לחלץ שום פרט מזהה אמין."
        ),
      documentPeriodLabel: z
        .string()
        .nullable()
        .describe(
          'אם המסמך מתייחס בבירור לתקופה או תאריך מסוימים (חודש התלוש, חודש דף הבנק, תאריך החשבונית) — ציין בפורמט "MM/YYYY" (למשל "01/2026"). null אם אין תאריך/תקופה ברור/ה במסמך, או שהמסמך אינו מסוג מסמך תקופתי.'
        ),
      periodExtractionConfidence: z
        .number()
        .min(0)
        .max(1)
        .describe('רמת ביטחון בתקופה/תאריך שחילצת ב-documentPeriodLabel. 0 אם documentPeriodLabel הוא null.'),
      documentReferenceNumber: z
        .string()
        .nullable()
        .describe("מספר חוזה/חשבון/תיק/הזמנה המודפס על המסמך, אם קיים. null אם אין מספר כזה גלוי."),
      pageNumberCurrent: z
        .number()
        .int()
        .nullable()
        .describe('מספר העמוד הנוכחי, אם מודפס על המסמך (למשל "עמוד 2 מתוך 3" -> 2). null אם לא מצוין.'),
      pageNumberTotal: z
        .number()
        .int()
        .nullable()
        .describe('סך כל העמודים, אם מודפס על המסמך (למשל "עמוד 2 מתוך 3" -> 3). null אם לא מצוין.'),
      readabilityIssue: z
        .enum(["blurry", "cropped_or_incomplete", "too_dark_or_low_quality", "damaged", "wrong_orientation", "other"])
        .nullable()
        .describe(
          "בעיית איכות תמונה אמיתית שהופכת את הקובץ ללא שמיש, גם אם ניחשת בסבירות טובה מה זה — למשל מטושטש מדי לקריאה, רק חלק מהמסמך נראה בתמונה, כהה/איכות נמוכה מדי, נראה פגום/קרוע, או מסובב. null אם התמונה קריאה וברורה, גם אם לא הצלחת לזהות מה המסמך."
        ),
      readabilityIssueDetail: z
        .string()
        .nullable()
        .describe(
          "תיאור קצר וממוקד של הבעיה בפועל, מבוסס רק על מה שאתה רואה בפועל (למשל \"רק החלק העליון של המסמך נראה בתמונה\"). null אם readabilityIssue הוא null."
        ),
      suspectedDocumentType: z
        .string()
        .nullable()
        .describe(
          'ניחוש זהיר לסוג המסמך, ורק כאשר identified=false אך יש רמז חלקי אמיתי לכך שזה עשוי להיות סוג מסוים (למשל "נראה כמו מסמך רשמי, יתכן תעודת זהות"). לעולם אל תמציא ניחוש — null אם באמת אין שום רמז.'
        ),
      clientMessageIfProblematic: z
        .string()
        .nullable()
        .describe(
          "הודעה קצרה, טבעית ואדיבה בעברית ללקוח, המיועדת להישלח מיד — רק כאשר readabilityIssue אינו null, או ש-identified הוא false (כלומר המסמך זקוק לשליחה חוזרת). ההודעה חייבת: (1) להתייחס למסמך שהתקבל בצורה שתאפשר ללקוח להבין לאיזה קובץ הכוונה (למשל \"המסמך האחרון ששלחת\"); (2) לציין את הבעיה בפועל, מבוססת רק על readabilityIssue/readabilityIssueDetail שמילאת — לעולם אל תמציא בעיה שלא צוינה; (3) אם יש suspectedDocumentType — לנסח בזהירות ובגמישות (\"נראה כמו...\", \"יתכן ש...\"), לעולם לא בוודאות; (4) לבקש במפורש לשלוח שוב צילום ברור/מלא; (5) לעולם לא לשאול \"האם שלחת אותו בכוונה?\" — זו לא השאלה הרלוונטית כשיש בעיה טכנית. null בכל מקרה אחר — כשהמסמך זוהה בהצלחה (בין אם הוא מתאים לדרישה ובין אם לא, כל עוד אין בעיית איכות)."
        ),
    });

    console.log("[wa-inbound] vision classification REQUEST", {
      mimeType,
      byteLength: fileBytes.length,
      candidateCount: candidateNames.length,
    });

    const { object } = await withAiOperation("document.vision_classify", () =>
      generateObject({
        model,
        schema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `זהו קובץ שלקוח שלח כדי לענות על אחת מהדרישות הבאות בבקשת איסוף מסמכים: ${candidateNames.join(", ")}. יש כמה שאלות נפרדות: (1) האם אתה יכול לזהות בבירור איזה סוג מסמך זה בפועל, גם אם הוא לא קשור לרשימה? (2) בהנחה שזיהית אותו, האם הוא בפועל עונה על אחת מהדרישות ברשימה, או שהוא סוג מסמך אחר לגמרי (כמו חשבונית, קבלה, או כל דבר אחר שלא התבקש)? אל תסמן התאמה רק כי המסמך זוהה — התאמה נדרשת רק כשהוא באמת מהסוג המבוקש. (3) אם מופיעים במסמך שם אדם, מספר תעודת זהות, או שם חברה — חלץ אותם בדיוק כפי שהם כתובים. אל תנחש ואל תשלים פרטים שלא כתובים בבירור במסמך עצמו. (4) אם המסמך מתייחס בבירור לתקופה/תאריך מסוימים (חודש תלוש שכר, חודש דף בנק, תאריך חשבונית) — ציין אותם. אל תנחש תאריך שלא כתוב בבירור במסמך. (5) אם מודפס על המסמך מספר חוזה/חשבון/תיק, או מספר עמוד (כמו "עמוד 2 מתוך 3") — ציין אותם בדיוק. אלה עוזרים לזהות אם כמה קבצים הם למעשה עמודים של אותו מסמך רב-עמודים. אל תנחש מספרים שלא מודפסים בבירור. (6) האם יש בעיית איכות תמונה אמיתית שהופכת את הקובץ ללא שמיש — מטושטש, רק חלק מהמסמך נראה, כהה/איכות נמוכה, פגום, או מסובב? ציין זאת רק אם זו בעיה אמיתית שאתה רואה בפועל, לא ניחוש. (7) אם המסמך זקוק לשליחה חוזרת (יש בעיית איכות, או שלא הצלחת לזהות מה זה בכלל) — נסח הודעה קצרה, טבעית ואדיבה ללקוח שמסבירה בדיוק את זה ומבקשת צילום חדש, תוך הקפדה מוחלטת שלא להמציא פרטים שאינך בטוח בהם ולנסח כל ניחוש בזהירות ("נראה כמו...").`,
              },
              { type: "file", data: fileBytes, mediaType: mimeType },
            ],
          },
        ],
      })
    );

    console.log("[wa-inbound] vision classification RESPONSE", {
      identified: object.identified,
      documentType: object.documentType,
      identificationConfidence: object.identificationConfidence,
      matchedRequirementName: object.matchedRequirementName,
      matchConfidence: object.matchConfidence,
      // Never the extracted name/ID themselves — PII stays out of logs.
      // Last 4 only, same rule outbound WhatsApp messages follow.
      extractedPersonNamePresent: !!object.extractedPersonName,
      extractedIdNumberLast4: object.extractedIdNumber ? object.extractedIdNumber.slice(-4) : null,
      extractedCompanyNamePresent: !!object.extractedCompanyName,
      identityExtractionConfidence: object.identityExtractionConfidence,
    });

    const matched =
      object.matchedRequirementName === NONE
        ? null
        : (candidates.find((c) => c.name === object.matchedRequirementName) ?? null);

    return {
      identified: object.identified,
      documentType: object.documentType,
      identificationConfidence: object.identificationConfidence,
      matchedRequirementId: matched?.id ?? null,
      matchConfidence: matched ? object.matchConfidence : 0,
      extractedPersonName: object.extractedPersonName,
      extractedIdNumber: object.extractedIdNumber ? object.extractedIdNumber.replace(/\D/g, "") || null : null,
      extractedCompanyName: object.extractedCompanyName,
      identityExtractionConfidence: object.identityExtractionConfidence,
      // Only trusted in the exact "MM/YYYY" shape the prompt asked for — a
      // malformed value from the model is treated the same as "no period",
      // never passed through as-is, since documentQuantity.ts's dedup logic
      // depends on exact string equality between sibling documents.
      documentPeriodLabel:
        object.documentPeriodLabel && /^(0[1-9]|1[0-2])\/\d{4}$/.test(object.documentPeriodLabel)
          ? object.documentPeriodLabel
          : null,
      periodExtractionConfidence: object.periodExtractionConfidence,
      documentReferenceNumber: object.documentReferenceNumber,
      pageNumberCurrent: object.pageNumberCurrent,
      pageNumberTotal: object.pageNumberTotal,
      readabilityIssue: object.readabilityIssue,
      readabilityIssueDetail: object.readabilityIssueDetail,
      suspectedDocumentType: object.suspectedDocumentType,
      clientMessageIfProblematic: object.clientMessageIfProblematic,
    };
  } catch (error) {
    console.error("[wa-inbound] vision classification FAILED (falling back to unrecognized)", error);
    return null;
  }
}
