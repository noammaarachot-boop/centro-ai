import { generateObject } from "ai";
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
    });

    console.log("[wa-inbound] vision classification REQUEST", {
      mimeType,
      byteLength: fileBytes.length,
      candidateCount: candidateNames.length,
    });

    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `זהו קובץ שלקוח שלח כדי לענות על אחת מהדרישות הבאות בבקשת איסוף מסמכים: ${candidateNames.join(", ")}. יש שתי שאלות נפרדות: (1) האם אתה יכול לזהות בבירור איזה סוג מסמך זה בפועל, גם אם הוא לא קשור לרשימה? (2) בהנחה שזיהית אותו, האם הוא בפועל עונה על אחת מהדרישות ברשימה, או שהוא סוג מסמך אחר לגמרי (כמו חשבונית, קבלה, או כל דבר אחר שלא התבקש)? אל תסמן התאמה רק כי המסמך זוהה — התאמה נדרשת רק כשהוא באמת מהסוג המבוקש.`,
            },
            { type: "file", data: fileBytes, mediaType: mimeType },
          ],
        },
      ],
    });

    console.log("[wa-inbound] vision classification RESPONSE", {
      identified: object.identified,
      documentType: object.documentType,
      identificationConfidence: object.identificationConfidence,
      matchedRequirementName: object.matchedRequirementName,
      matchConfidence: object.matchConfidence,
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
    };
  } catch (error) {
    console.error("[wa-inbound] vision classification FAILED (falling back to unrecognized)", error);
    return null;
  }
}
