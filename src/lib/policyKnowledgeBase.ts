import { and, eq } from "drizzle-orm";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getDb } from "@/db";
import { approvedPolicies } from "@/db/schema";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";

/**
 * The office's own accumulated, semantically-searchable knowledge —
 * "AI understands the question, the office decides, and only an explicit
 * office decision ever becomes reusable knowledge." A policy is NEVER
 * created automatically (see src/lib/employeeReview.ts's
 * resolveEmployeeReviewItem — promotion is always an explicit employee
 * opt-in). This module only ever MATCHES a new question against
 * already-approved policies and phrases the matched answer naturally; it
 * never writes a policy itself.
 *
 * Matching is by MEANING, never literal wording — the client's phrasing
 * never needs to match how the policy was originally recorded. Same "never
 * invent" discipline as every other AI step in this codebase: the matcher
 * is given the org's real active policies (real ids only) and must return
 * an id from that exact list, or null — never a fabricated id, never a
 * guess under the confidence floor.
 *
 * Scaling note: the full active-policy list is passed into one prompt —
 * fine at a small office's realistic scale (dozens to low hundreds of
 * accumulated policies). No embeddings/vector-search infrastructure exists
 * anywhere in this codebase; if a policy library ever grew into the
 * thousands, a pre-filtering retrieval step would be needed. Out of scope
 * here.
 */

const MIN_POLICY_MATCH_CONFIDENCE = 0.75;

export type ApprovedPolicy = typeof approvedPolicies.$inferSelect;

export async function listActivePolicies(organizationId: string): Promise<ApprovedPolicy[]> {
  const db = await getDb();
  return db
    .select()
    .from(approvedPolicies)
    .where(and(eq(approvedPolicies.organizationId, organizationId), eq(approvedPolicies.isActive, true)));
}

export interface PolicyMatchResult {
  policyId: string | null;
  confidence: number;
}

const matchSchema = z.object({
  matchedPolicyId: z
    .string()
    .nullable()
    .describe(
      "ה-id המדויק (חייב להיות זהה בדיוק לאחד מה-id-ים ברשימה) של המדיניות שעונה על השאלה מבחינת המשמעות שלה — לא בהכרח באותו ניסוח מילולי. לעולם אל תמציא id. null אם אף מדיניות לא עונה על השאלה, גם אם היא קרובה חלקית."
    ),
  confidence: z.number().min(0).max(1).describe("רמת ביטחון שההתאמה נכונה, 0 עד 1. השתמש בערך נמוך כשאינך בטוח."),
});

// try/catch -> { policyId: null, confidence: 0 } on any failure — never
// guesses, matching classifyRequestMessageIntent's own safe-default
// discipline.
export async function matchClientQuestionToPolicy(
  clientQuestion: string,
  candidates: ApprovedPolicy[]
): Promise<PolicyMatchResult> {
  const trimmed = clientQuestion.trim();
  if (!trimmed || candidates.length === 0) return { policyId: null, confidence: 0 };

  try {
    const model = await resolveLanguageModel();
    const candidateLines = candidates
      .map((p) => `[id=${p.id}] ${p.questionSummary}${p.relatedDocumentType ? ` (בהקשר: ${p.relatedDocumentType})` : ""}`)
      .join("\n");

    const { object } = await generateObject({
      model,
      schema: matchSchema,
      messages: [
        {
          role: "user",
          content: [
            "להלן רשימת מדיניות שכבר אושרה במשרד, כל אחת עם ה-id האמיתי שלה:",
            candidateLines,
            "",
            `שאלה חדשה מלקוח: "${trimmed}"`,
            "",
            "האם אחת מהמדיניות שלמעלה עונה על השאלה הזו, מבחינת המשמעות (הניסוח יכול להיות שונה לגמרי)? אם כן, החזר את ה-id המדויק שלה. אם לא בטוח או שאף מדיניות לא מכסה את זה — החזר null. לעולם אל תמציא id שלא ברשימה.",
          ].join("\n"),
        },
      ],
    });

    if (!object.matchedPolicyId || object.confidence < MIN_POLICY_MATCH_CONFIDENCE) {
      return { policyId: null, confidence: object.confidence };
    }
    // Never trust a returned id blindly — validate against the exact
    // candidate list this call was given.
    const validId = candidates.some((p) => p.id === object.matchedPolicyId);
    if (!validId) {
      console.warn("[policy-knowledge-base] matcher returned a policyId not in the candidate list", {
        returnedId: object.matchedPolicyId,
      });
      return { policyId: null, confidence: 0 };
    }
    return { policyId: object.matchedPolicyId, confidence: object.confidence };
  } catch (error) {
    console.error("[policy-knowledge-base] matching failed (falling back to no match)", error);
    return { policyId: null, confidence: 0 };
  }
}

// Weaves the matched policy's employee-authored decisionText into a
// natural, first-person client-facing reply addressing THIS specific
// question — never invents new policy content, only rephrases what's
// already there. Falls back to a safe, near-verbatim deterministic
// template on any AI failure, since a matched policy must still get an
// immediate reply (never silence) once a match is found.
export async function renderPolicyAnswer(clientQuestion: string, policy: { decisionText: string; questionSummary: string }): Promise<string> {
  try {
    const model = await resolveLanguageModel();
    const { text } = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            `לקוח שאל: "${clientQuestion.trim()}"`,
            `המדיניות המאושרת הרלוונטית: ${policy.decisionText}`,
            "",
            "נסח תשובה קצרה, טבעית וישירה ללקוח (גוף ראשון, בעברית, כמו הודעת וואטסאפ אנושית), שמשקפת בדיוק את המדיניות שלמעלה ועונה על השאלה הספציפית שהוא שאל. אל תוסיף מידע או תנאים שלא מופיעים במדיניות עצמה.",
          ].join("\n"),
        },
      ],
    });
    const trimmed = text.trim();
    return trimmed || policy.decisionText;
  } catch (error) {
    console.error("[policy-knowledge-base] answer phrasing failed (falling back to the policy text itself)", error);
    return policy.decisionText;
  }
}
