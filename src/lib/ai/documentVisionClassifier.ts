import { generateObject } from "ai";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import type { DocumentClassificationCandidate } from "./documentClassifierTypes";

export interface VisionClassificationResult {
  matchedRequirementId: string | null;
  confidence: number;
  documentType: string;
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

// Never throws — any failure (no provider configured, API error, timeout,
// a malformed/unparseable model response) resolves to null so the caller
// falls through to the existing needs_review path. A classification outage
// must never block a document from being received and stored (same
// resilience principle as withRetry/uploadDocumentResiliently elsewhere in
// this pipeline).
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
    const NONE = "לא ידוע / לא תואם";

    const schema = z.object({
      documentType: z.string().describe("תיאור קצר בעברית של סוג המסמך בפועל (למשל: תעודת זהות, תלוש שכר, דף חשבון בנק)"),
      matchedRequirementName: z
        .enum([NONE, ...candidateNames])
        .describe("ההעתקה המדויקת של השם, מתוך רשימת הדרישות שסופקה, שהמסמך הזה עונה עליה — או הערך המיוחד אם אף אחת לא מתאימה"),
      confidence: z.number().min(0).max(1).describe("רמת ביטחון בהתאמה, מ-0 עד 1"),
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
              text: `זהו קובץ שלקוח שלח כדי לענות על אחת מהדרישות הבאות בבקשת איסוף מסמכים: ${candidateNames.join(", ")}. זהה איזה סוג מסמך זה בפועל, ואיזו דרישה מהרשימה, אם בכלל, הוא עונה עליה. אם הקובץ לא ברור, לא קריא, או לא תואם אף דרישה מהרשימה — ציין זאת בבירור והחזר "${NONE}".`,
            },
            { type: "file", data: fileBytes, mediaType: mimeType },
          ],
        },
      ],
    });

    console.log("[wa-inbound] vision classification RESPONSE", {
      documentType: object.documentType,
      matchedRequirementName: object.matchedRequirementName,
      confidence: object.confidence,
    });

    if (object.matchedRequirementName === NONE) {
      return { matchedRequirementId: null, confidence: object.confidence, documentType: object.documentType };
    }
    const matched = candidates.find((c) => c.name === object.matchedRequirementName);
    return {
      matchedRequirementId: matched?.id ?? null,
      confidence: object.confidence,
      documentType: object.documentType,
    };
  } catch (error) {
    console.error("[wa-inbound] vision classification FAILED (falling back to needs_review)", error);
    return null;
  }
}
