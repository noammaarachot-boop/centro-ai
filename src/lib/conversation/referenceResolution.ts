import { generateObject } from "ai";
import { z } from "zod";
import { getDb } from "@/db";
import { clientConversationFocus } from "@/db/schema";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import type { ConversationContext } from "@/lib/conversation/conversationContext";
import type { ConfirmedFocusSource, ResolvedReference } from "@/lib/conversation/conversationReasoning";

/**
 * Phase 2 (conversation-intelligence redesign) — general discourse-entity
 * reference resolution. Answers ONE question: what, if anything, does the
 * current message's "it"/"the first one"/"that"/"the second"/a topic switch
 * actually point at — a document, a requirement, a collection request, a
 * review item, or nothing in particular? Never decides what to DO about it
 * (that's Phase 3's ACT/ANSWER/CLARIFY/ESCALATE reasoning) and never writes
 * anything to the database itself (see confirmDurableFocus below, a
 * deliberately separate function — resolution and mutation never share a
 * call).
 *
 * NOT wired into route.ts/conversationDispatch.ts/classifyConversationIntent
 * in this phase — those keep running exactly as they do today. This module
 * is built and proven in isolation; wiring it into the live dispatch is
 * Phase 3's job.
 */

export type ReferenceResolutionResult =
  | { status: "resolved"; reference: ResolvedReference }
  // candidateIds is best-effort (the model's own shortlist) — callers must
  // never guess among them; the only legitimate next step is CLARIFY.
  | { status: "ambiguous"; candidateIds: string[] }
  | { status: "no_reference" };

const schema = z.object({
  status: z.enum(["resolved", "ambiguous", "no_reference"]),
  referentKind: z.enum(["collection_request", "document", "requirement", "review_item"]).nullable(),
  referentId: z
    .string()
    .nullable()
    .describe("רק כאשר status='resolved'. ה-id המדויק מתוך רשימת ה-entities או ה-focus המאושר למטה. לעולם אל תמציאי id."),
  provenance: z
    .enum(["confirmed_focus", "message_explicit", "context_inferred"])
    .nullable()
    .describe(
      "רק כאשר status='resolved'. 'confirmed_focus' — הסתמכת על ה-focus המאושר הקיים, ההודעה לא סתרה אותו. 'message_explicit' — ההודעה עצמה קבעה/שינתה את ההפניה במפורש (כולל תיקון כמו 'לא, התכוונתי ל...'). 'context_inferred' — הסקת מהקשר רך של השיחה בלבד, בלי אינדיקציה מפורשת."
    ),
  confidence: z.number().min(0).max(1).describe("רמת ביטחון, 0 עד 1. נמוך כשלא בטוחה."),
  basis: z.string().nullable().describe("הסבר פנימי קצר בעברית, לעולם לא מוצג ללקוח."),
  ambiguousCandidateIds: z
    .array(z.string())
    .nullable()
    .describe("רק כאשר status='ambiguous': אילו entities מתוך הרשימה סבירים, בלי לבחור ביניהם."),
});

function formatCandidates(context: ConversationContext): string {
  if (context.recentDiscourseEntities.length === 0) return "אין entities רלוונטיים ידועים.";
  return context.recentDiscourseEntities.map((e) => `[kind=${e.kind}][id=${e.id}] ${e.label}`).join("\n");
}

function formatConfirmedFocus(context: ConversationContext): string {
  if (!context.confirmedFocus) return "אין focus מאושר כרגע — אין הנחה קודמת לגבי איזו בקשה רלוונטית.";
  return (
    `focus מאושר כרגע: collection_request [id=${context.confirmedFocus.collectionRequestId}] ` +
    `(נקבע ע"י ${context.confirmedFocus.source}). זהו prior חזק — אם ההודעה הנוכחית לא סותרת/משנה אותו, ` +
    `הסתמכי עליו (provenance=confirmed_focus). אם ההודעה עצמה מציינת במפורש הפניה אחרת (למשל בקשה אחרת, ` +
    `או תיקון כמו "לא, התכוונתי ל...") — ההודעה גוברת מיד (provenance=message_explicit).`
  );
}

function formatRecentMessages(context: ConversationContext): string {
  if (context.recentMessages.length === 0) return "אין הודעות קודמות.";
  return context.recentMessages.map((m) => `${m.direction === "inbound" ? "לקוח" : "Centro"}: "${m.body}"`).join("\n");
}

export async function resolveConversationReference(
  context: ConversationContext,
  messageText: string
): Promise<ReferenceResolutionResult> {
  const trimmed = messageText.trim();
  if (!trimmed) return { status: "no_reference" };

  try {
    const model = await resolveLanguageModel();
    const { object } = await generateObject({
      model,
      schema,
      messages: [
        {
          role: "user",
          content: [
            "שיחה בין Centro (מערכת איסוף מסמכים בוואטסאפ) ללקוח. המטרה כאן אינה לענות על ההודעה — רק לזהות למה היא מתייחסת (discourse reference), אם בכלל.",
            "",
            formatConfirmedFocus(context),
            "",
            "Entities אמיתיים שההודעה עשויה להתייחס אליהם (ה-id בסוגריים מרובעים הוא האמיתי היחיד שמותר להחזיר):",
            formatCandidates(context),
            "",
            "הודעות אחרונות בשיחה (כולל תשובות Centro עצמן — הפניה כמו \"הראשון\"/\"השני\" עשויה להתייחס לפריט הראשון/השני שהוזכר בתשובה האחרונה של Centro, לא בהכרח למועמד מהרשימה למעלה — התאימי לפי המשמעות בפועל):",
            formatRecentMessages(context),
            "",
            `ההודעה החדשה: "${trimmed}"`,
            "",
            "הנחיות מחייבות:",
            "- status='resolved' רק כשברור למה ההודעה מתייחסת. ציין kind ו-id מדויקים מתוך הרשימות למעלה בלבד (או ה-id של ה-focus המאושר, אם הוא הרלוונטי), provenance מדויק, ו-confidence אמיתי.",
            "- תיקון/שינוי מפורש בהודעה (למשל \"לא, התכוונתי ל...\") הוא תמיד provenance='message_explicit' עם confidence גבוה — לעולם לא ambiguous רק כי זה סותר את ה-focus הקודם.",
            "- status='ambiguous' כשיש 2+ אפשרויות סבירות וממשית לא ברור למי מתכוונים, וזה משנה מהותית את המשמעות. לעולם אל תנחשי בין מועמדים.",
            "- status='no_reference' כשההודעה עומדת בפני עצמה ולא מפנה לשום entity ספציפי.",
            "- לעולם אל תמציאי id שלא מופיע ברשימות למעלה.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    if (object.status === "ambiguous") {
      return { status: "ambiguous", candidateIds: object.ambiguousCandidateIds ?? [] };
    }
    if (object.status === "no_reference") {
      return { status: "no_reference" };
    }

    if (!object.referentKind || !object.referentId || !object.provenance) {
      // A malformed "resolved" (missing a required field) is never trusted
      // as resolved — degrade to ambiguous rather than guess.
      return { status: "ambiguous", candidateIds: [] };
    }

    // Never trust the id blindly — it must be a real, current candidate
    // (recentDiscourseEntities) or the confirmed focus's own
    // collectionRequestId. Anything else is treated as if the model had
    // said "ambiguous" — the exact discipline correctionTargetId already
    // requires (conversationIntent.ts: "לעולם אל תמציאי id").
    const validIds = new Set<string>([
      ...context.recentDiscourseEntities.filter((e) => e.kind === object.referentKind).map((e) => e.id),
      ...(context.confirmedFocus && object.referentKind === "collection_request"
        ? [context.confirmedFocus.collectionRequestId]
        : []),
    ]);
    if (!validIds.has(object.referentId)) {
      console.warn("[reference-resolution] model returned an id outside the real candidate set — treating as ambiguous", {
        referentKind: object.referentKind,
        referentId: object.referentId,
      });
      return { status: "ambiguous", candidateIds: [] };
    }

    return {
      status: "resolved",
      reference: {
        kind: object.referentKind,
        id: object.referentId,
        confidence: object.confidence,
        provenance: object.provenance,
        basis: object.basis ?? "",
      },
    };
  } catch (error) {
    console.error("[reference-resolution] resolution failed (falling back to no_reference)", error);
    return { status: "no_reference" };
  }
}

// The ONLY function anywhere allowed to write client_conversation_focus.
// Deliberately separate from resolveConversationReference above —
// resolution (interpretation) and this (mutation of durable conversational
// state) never share a call, so no LLM output can reach the database
// without an explicit, separate, deterministic decision by the caller in
// between. Once wired into the live dispatch (a later phase), the only
// callers that may legitimately invoke this are: the trivial
// single-open-request case, a resolved numbered disambiguation reply, or a
// resolveConversationReference result with
// provenance==="message_explicit" AND referentKind==="collection_request"
// AND confidence above a real bar — a bare "context_inferred" result never
// qualifies, no matter how confident (see ConfirmedFocusSource's own schema
// doc comment: durable state requires an explicit signal, never inference
// alone).
export async function confirmDurableFocus(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  source: ConfirmedFocusSource;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(clientConversationFocus)
    .values({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      source: params.source,
    })
    .onConflictDoUpdate({
      target: [clientConversationFocus.clientId],
      set: { collectionRequestId: params.collectionRequestId, source: params.source, setAt: new Date(), updatedAt: new Date() },
    });
}
