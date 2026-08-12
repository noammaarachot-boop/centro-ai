import { generateObject, generateText } from "ai";
import { z } from "zod";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { handlePotentialReviewQuestion } from "@/lib/employeeReview";
import { buildConversationContext, type ConversationContext } from "@/lib/conversation/conversationContext";
import { resolveConversationReference, type ReferenceResolutionResult } from "@/lib/conversation/referenceResolution";
import { validateAndExecuteAction } from "@/lib/conversation/actionExecution";
import type { ActionContract, ReasoningOutcome } from "@/lib/conversation/conversationReasoning";

/**
 * Phase 3 (conversation-intelligence redesign) — the general reasoning
 * layer: message + context + reference resolution -> ACT | ANSWER | CLARIFY
 * | ESCALATE | UNRELATED, plus grounded answer composition. These are
 * reasoning OUTCOMES, not a new intent taxonomy — ACT's sub-kinds are
 * exactly today's action-triggering ConversationIntentKind values
 * (unchanged), and ANSWER carries no fixed category enum at all (the model
 * composes the reply itself, from facts it actually cites).
 *
 * NOT wired into route.ts/conversationDispatch.ts in this phase.
 * classifyConversationIntent/runConversationUnderstanding keep running
 * exactly as they do today — this module is built and proven in isolation
 * (see conversationUnderstanding.test.ts); wiring it into the live
 * dispatch is a later phase's job.
 */

interface GroundedFact {
  id: string;
  label: string;
  detail: string;
}

// Scoped, not exhaustive — exactly the facts a human assistant reading this
// one case would have in front of them (Phase 1's own context, nothing
// more). Never "the whole DB": no cross-organization data, no other
// clients, and sibling requests appear only as lightweight labels, not
// their own deep fact sets.
function buildGroundedFactPool(context: ConversationContext): GroundedFact[] {
  const facts: GroundedFact[] = [
    {
      id: "active_request",
      label: `הבקשה הפעילה: ${context.activeRequest.serviceName} — ${context.activeRequest.periodLabel}`,
      detail: `סטטוס: ${context.activeRequest.status}, נפתחה ב-${context.activeRequest.createdAt}`,
    },
    {
      id: "organization",
      label: `פרטי המשרד: ${context.organization.name}`,
      detail: `שעות פעילות: ${context.organization.businessHoursStart}-${context.organization.businessHoursEnd} (ימים: ${context.organization.businessDays}), אזור זמן: ${context.organization.timezone}`,
    },
  ];
  for (const f of context.requirementFacts) {
    // Partial progress on a quantity requirement (e.g. "2 מתוך 3 תלושי
    // שכר") is real, verified information a client asking "כמה עוד חסר
    // לי?" needs — collapsing it to a bare satisfied/not-satisfied flag
    // would make an honest, groundable answer impossible to compose, even
    // though the data was available. Mirrors requestQnA.ts's own
    // renderOverviewAnswer phrasing for the same fact.
    const detail = f.satisfied ? "התקבל, תודה" : f.satisfiedCount > 0 ? `התקבלו ${f.satisfiedCount} מתוך ${f.requiredCount}` : "טרם התקבל";
    facts.push({ id: f.id, label: f.description, detail });
  }
  for (const d of context.recentDocuments) {
    facts.push({ id: d.id, label: d.documentType ?? d.requirementName ?? "מסמך", detail: `סטטוס: ${d.status}` });
  }
  for (const p of context.activePolicies) {
    facts.push({ id: p.id, label: p.questionSummary, detail: p.decisionText });
  }
  for (const r of context.otherOpenRequests) {
    facts.push({ id: r.collectionRequestId, label: `בקשה נוספת של הלקוח: ${r.serviceName} — ${r.periodLabel}`, detail: `סטטוס: ${r.status}` });
  }
  return facts;
}

const outcomeSchema = z.object({
  outcome: z.enum(["ACT", "ANSWER", "CLARIFY", "ESCALATE", "UNRELATED"]).describe(
    '"ACT" — ההודעה דורשת/מבצעת פעולה קונקרטית ומוגדרת (מענה על שאלה פתוחה, תיקון החלטה קודמת, דיווח על מסמך חסר, סיום, הבטחה לשלוח בעתיד, פתרון פריט לבדיקת עובד). ' +
      '"ANSWER" — יש שאלה, וניתן לענות עליה מהעובדות הידועות (למטה) — בכל ניסוח, גם כזה שלא הוגדר מראש. ' +
      '"CLARIFY" — לא ניתן לענות/לפעול בלי פרט חסר מהלקוח, וזה פרט הכרחי (לא נוחות בלבד). ' +
      '"ESCALATE" — נדרשת החלטה/מידע אנושי אמיתי שאין למערכת סמכות או יכולת לספק — לא כי הניסוח לא מוכר, לא כי חסר מידע שאפשר לענות עליו בכנות שהוא לא קיים. ' +
      '"UNRELATED" — ההודעה לא קשורה כלל לבקשת המסמכים הפעילה.'
  ),
  confidence: z.number().min(0).max(1).describe("רמת ביטחון כללית, 0 עד 1. נמוך כשלא בטוחה."),

  actionKind: z
    .enum([
      "resolve_pending",
      "resolve_clarification",
      "correct_resolved",
      "report_missing_document",
      "finish_request",
      "defer",
      "resolve_review_item",
    ])
    .nullable()
    .describe(
      'רק כאשר outcome="ACT". "resolve_pending"/"resolve_clarification" — עונה על השאלה הפתוחה המוצגת למטה (clarification אם היא פתוחה חופשית, אחרת yes/no). "correct_resolved" — מתייחס למסמך/החלטה שכבר טופלו ומבקש לשנות. "report_missing_document" — אומר בבירור שאין לו מסמך נדרש. "finish_request" — אומר בבירור שסיים לשלוח הכל. "defer" — מבטיח לשלוח בעתיד. "resolve_review_item" — מתייחס בבירור לאחד מפריטי הבדיקה המוצגים למטה.'
    ),
  actionOpenQuestionId: z.string().nullable().describe('רק ל-resolve_pending/resolve_clarification: ה-id המדויק של השאלה הפתוחה.'),
  actionAnswer: z.enum(["confirm", "decline"]).nullable().describe('רק ל-resolve_pending כשהשאלה הפתוחה היא כן/לא.'),
  actionReplyText: z.string().nullable().describe('רק ל-resolve_clarification/defer: הטקסט הרלוונטי מההודעה עצמה.'),
  actionTargetType: z.enum(["document", "confirmation"]).nullable().describe('רק ל-correct_resolved.'),
  actionTargetId: z.string().nullable().describe('רק ל-correct_resolved: ה-id המדויק מהרשימות למטה. לעולם אל תמציאי.'),
  actionDesiredOutcome: z
    .enum(["attach_to_requirement", "save_as_extra", "mark_withdrawn"])
    .nullable()
    .describe('רק ל-correct_resolved.'),
  actionMentionedType: z.string().nullable().describe('רק ל-report_missing_document: איזה מסמך צוין, אם צוין.'),
  actionReviewItemId: z.string().nullable().describe('רק ל-resolve_review_item: ה-id המדויק מרשימת פריטי הבדיקה למטה.'),
  actionReviewAction: z.enum(["close_resolved", "add_context_note"]).nullable().describe('רק ל-resolve_review_item.'),
  actionReviewReason: z.string().nullable().describe('רק ל-resolve_review_item: הסבר פנימי קצר, לעולם לא מוצג ללקוח.'),
  actionAcknowledgment: z.string().nullable().describe('רק ל-resolve_review_item: תגובה טבעית קצרה ללקוח, מבוססת אך ורק על מה שההודעה אמרה.'),

  answerGroundedOn: z
    .array(z.string())
    .nullable()
    .describe('רק כאשר outcome="ANSWER": אילו id-ים מרשימת העובדות למטה רלוונטיים לתשובה. רשימה ריקה מותרת אם התשובה היא שאין מידע.'),

  clarifyQuestion: z.string().nullable().describe('רק כאשר outcome="CLARIFY": שאלת הבהרה ממוקדת וקצרה ללקוח.'),
  clarifyMissing: z.string().nullable().describe('רק כאשר outcome="CLARIFY": מה בדיוק חסר, הסבר פנימי קצר.'),

  escalateCategory: z
    .enum(["alternative_or_policy_question", "human_request", "other"])
    .nullable()
    .describe('רק כאשר outcome="ESCALATE".'),
  escalateGist: z.string().nullable().describe('רק כאשר outcome="ESCALATE": תקציר קצר וברור עבור העובד, בעברית.'),
});

function formatFacts(facts: GroundedFact[]): string {
  if (facts.length === 0) return "אין עובדות ידועות.";
  return facts.map((f) => `[id=${f.id}] ${f.label} — ${f.detail}`).join("\n");
}

function formatReference(reference: ReferenceResolutionResult): string {
  if (reference.status === "resolved") {
    return `זיהוי הפניה בהודעה: מתייחסת ל-[kind=${reference.reference.kind}][id=${reference.reference.id}] (provenance=${reference.reference.provenance}, ביטחון ${reference.reference.confidence.toFixed(2)}).`;
  }
  if (reference.status === "ambiguous") {
    return `זיהוי הפניה בהודעה: עמום בין כמה אפשרויות (${reference.candidateIds.join(", ") || "לא צוין"}) — אם ההפניה הזו הכרחית כדי לענות/לפעול, יש לשאול הבהרה ולא לנחש; אם היא לא הכרחית, אפשר להתעלם ולהמשיך.`;
  }
  return "זיהוי הפניה בהודעה: ההודעה לא מפנה לשום entity ספציפי.";
}

function formatOpenQuestion(context: ConversationContext): string {
  return context.openQuestion
    ? `שאלה פתוחה שממתינה לתשובה כרגע (סוג: ${context.openQuestion.kind}, id=${context.openQuestion.id}): "${context.openQuestion.question}"`
    : "אין כרגע שאלה פתוחה.";
}

function formatReviewItems(context: ConversationContext): string {
  if (context.reviewItems.length === 0) return "אין פריטים לבדיקת עובד.";
  return context.reviewItems
    .map((r) => `[id=${r.id}] (${r.status === "pending" ? "ממתין להחלטת משרד" : "כבר נענה"}) "${r.clientQuestion}"${r.gist ? ` — ${r.gist}` : ""}`)
    .join("\n");
}

function formatCandidateDocuments(context: ConversationContext): string {
  if (context.recentDocuments.length === 0) return "אין מסמכים אחרונים.";
  return context.recentDocuments.map((d) => `[id=${d.id}] ${d.documentType ?? "מסמך"} — סטטוס: ${d.status}`).join("\n");
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

export async function reasonAboutMessage(
  context: ConversationContext,
  messageText: string,
  reference: ReferenceResolutionResult
): Promise<ReasoningOutcome> {
  const trimmed = messageText.trim();
  if (!trimmed) return { kind: "UNRELATED" };

  const facts = buildGroundedFactPool(context);

  try {
    const model = await resolveLanguageModel();
    const { object } = await generateObject({
      model,
      schema: outcomeSchema,
      messages: [
        {
          role: "user",
          content: [
            "לקוח של Centro (מערכת לאיסוף מסמכים למשרד, בוואטסאפ) שלח הודעה חדשה. Centro עוסק אך ורק בתחום המסמכים והדרישות של הבקשה הפעילה — לעולם אינו chatbot כללי. המטרה: להבין את כוונת הלקוח מתוך ההקשר המלא, לא לפי מילות מפתח קבועות.",
            "",
            formatReference(reference),
            formatOpenQuestion(context),
            "",
            "עובדות ידועות ומאומתות (מקור האמת היחיד לתשובות — ה-id בסוגריים הוא האמיתי):",
            formatFacts(facts),
            "",
            "מסמכים אחרונים:",
            formatCandidateDocuments(context),
            "",
            "החלטות אחרונות שכבר נענו:",
            formatCandidateConfirmations(context),
            "",
            "פריטים לבדיקת עובד (פתוחים ושנפתרו לאחרונה):",
            formatReviewItems(context),
            "",
            "הודעות אחרונות בשיחה:",
            formatRecentMessages(context),
            "",
            `ההודעה החדשה מהלקוח: "${trimmed}"`,
            "",
            "הנחיות מחייבות:",
            "- ANSWER מותר על כל שאלה, גם ניסוח חדש שלא הוגדר מראש, כל עוד יש עובדה אמיתית ברשימה למעלה שעונה עליה — או עובדה כלשהי שמלמדת בבירור שהתשובה היא 'אין מידע כזה' (זו תשובה כנה, לא סיבה ל-CLARIFY/ESCALATE).",
            "- לעולם אל תמציאי עובדה, מדיניות, מסמך, deadline, או סטטוס שלא מופיע ברשימה למעלה.",
            "- ESCALATE רק כשבאמת נדרשת החלטה/מידע אנושי — לא כי הניסוח לא מוכר ולא רק כי חסר מידע שאפשר לענות עליו בכנות שהוא לא קיים.",
            "- CLARIFY רק כשההפניה/הפרט החסר הכרחי לתשובה או לפעולה — אחרת אל תשאלי שאלת הבהרה מיותרת.",
            "- ACT רק לפעולה מוגדרת וברורה; ציין actionKind מדויק ואת השדות הרלוונטיים לו בלבד. לעולם אל תמציאי id.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    return mapToOutcome(object);
  } catch (error) {
    // Phase 4 — a genuine reasoning failure (provider error, timeout,
    // malformed response) is never the same thing as "understood the
    // message and it's unrelated" — see ReasoningOutcome's own doc
    // comment for why these must stay distinct.
    console.error("[conversation-understanding] reasoning failed", error);
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "REASONING_FAILED", reason: reason.slice(0, 500) };
  }
}

function mapToOutcome(object: z.infer<typeof outcomeSchema>): ReasoningOutcome {
  if (object.outcome === "UNRELATED") return { kind: "UNRELATED" };

  if (object.outcome === "CLARIFY") {
    return { kind: "CLARIFY", question: object.clarifyQuestion ?? "אפשר להבהיר?", missing: object.clarifyMissing ?? "" };
  }

  if (object.outcome === "ESCALATE") {
    return {
      kind: "ESCALATE",
      category: object.escalateCategory ?? "other",
      gist: object.escalateGist ?? "",
    };
  }

  if (object.outcome === "ANSWER") {
    // No free text here — the model only cites which facts are relevant;
    // the caller (understandConversationTurn) validates those ids and
    // composes the actual reply via composeGroundedAnswer, using only the
    // validated facts. This is the second, independent grounding check.
    return { kind: "ANSWER", text: "", groundedOn: object.answerGroundedOn ?? [] };
  }

  // outcome === "ACT"
  const action = buildActionContract(object);
  if (!action) return { kind: "CLARIFY", question: "אפשר להבהיר בדיוק למה התכוונת?", missing: "malformed action proposal" };
  return { kind: "ACT", action, confidence: object.confidence };
}

function buildActionContract(object: z.infer<typeof outcomeSchema>): ActionContract | null {
  switch (object.actionKind) {
    case "resolve_pending":
      if (!object.actionOpenQuestionId || !object.actionAnswer) return null;
      return { kind: "resolve_pending", openQuestionId: object.actionOpenQuestionId, answer: object.actionAnswer };
    case "resolve_clarification":
      if (!object.actionOpenQuestionId || !object.actionReplyText) return null;
      return { kind: "resolve_clarification", openQuestionId: object.actionOpenQuestionId, replyText: object.actionReplyText };
    case "correct_resolved":
      if (!object.actionTargetType || !object.actionTargetId || !object.actionDesiredOutcome) return null;
      return {
        kind: "correct_resolved",
        targetType: object.actionTargetType,
        targetId: object.actionTargetId,
        desiredOutcome: object.actionDesiredOutcome,
      };
    case "report_missing_document":
      return { kind: "report_missing_document", mentionedType: object.actionMentionedType };
    case "finish_request":
      return { kind: "finish_request" };
    case "defer":
      if (!object.actionReplyText) return null;
      return { kind: "defer", replyText: object.actionReplyText };
    case "resolve_review_item":
      if (!object.actionReviewItemId || !object.actionReviewAction) return null;
      return {
        kind: "resolve_review_item",
        reviewItemId: object.actionReviewItemId,
        action: object.actionReviewAction,
        reason: object.actionReviewReason ?? "",
        acknowledgment: object.actionAcknowledgment ?? "",
      };
    default:
      return null;
  }
}

// Generalizes policyKnowledgeBase.ts's renderPolicyAnswer to any grounded
// fact set, not just approved policies — same discipline (generateText,
// explicit "only these facts, never add anything else" instruction). An
// empty fact list is not an error: it composes an honest "no verified
// information" answer, which is itself the correct grounded response when
// nothing relevant is known (never silently escalates, never invents).
export async function composeGroundedAnswer(question: string, facts: GroundedFact[]): Promise<string> {
  const NO_DATA_FALLBACK = "אין לי כרגע מידע מאומת שעונה על השאלה הזו — אבדוק ואחזור אליך.";
  try {
    const model = await resolveLanguageModel();
    const { text } = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            `לקוח שאל: "${question.trim()}"`,
            "",
            facts.length > 0
              ? `העובדות הידועות שמותר להשתמש בהן (ואך ורק בהן):\n${facts.map((f) => `- ${f.label}: ${f.detail}`).join("\n")}`
              : "אין שום עובדה ידועה ומאומתת שרלוונטית לשאלה הזו.",
            "",
            "נסח תשובה קצרה, טבעית וישירה ללקוח (גוף ראשון, בעברית, כמו הודעת וואטסאפ אנושית). " +
              "אם אין עובדה שעונה על השאלה — אמור בכנות ובאדיבות שאין לך את המידע הזה מאומת במערכת, בלי לנחש. " +
              "לעולם אל תוסיף מידע, תנאי, מספר, מדיניות או תאריך שלא הופיעו בעובדות שלמעלה.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    return text.trim() || NO_DATA_FALLBACK;
  } catch (error) {
    console.error("[conversation-understanding] grounded answer composition failed", error);
    return NO_DATA_FALLBACK;
  }
}

// Every disposition understandConversationTurn can ever return — Phase 4's
// production wiring (route.ts) branches on `outcome`, not just `handled`,
// so REASONING_FAILED is observable and never silently indistinguishable
// from a confident UNRELATED decision.
export type ConversationTurnResult = { handled: boolean; outcome: ReasoningOutcome["kind"] };

// The orchestrator: message -> context -> reference resolution -> reasoning
// outcome -> grounded answer / validated action / clarify / escalate.
// Called from route.ts as of Phase 4 — see this module's own top-of-file
// doc comment for the full flow this replaces.
export async function understandConversationTurn(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  messageText: string;
}): Promise<ConversationTurnResult> {
  const context = await buildConversationContext({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
  });
  const reference = await resolveConversationReference(context, params.messageText);
  const outcome = await reasonAboutMessage(context, params.messageText, reference);

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: outcome.kind === "REASONING_FAILED" ? "message.conversation_reasoning_failed" : "message.conversation_reasoning_outcome",
    description:
      outcome.kind === "REASONING_FAILED"
        ? `הבנת הודעת הלקוח נכשלה טכנית (לא "לא רלוונטי" — כשל אמיתי): ${outcome.reason}`
        : `הודעת הלקוח טופלה כ-${outcome.kind}`,
    actorType: "ai",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { outcome: outcome.kind, referenceStatus: reference.status },
  });

  if (outcome.kind === "REASONING_FAILED") {
    // Deterministic, safe, and final: no reply, no mutation, no fallback to
    // legacy — a second AI-backed classifier (classifyConversationIntent)
    // depends on the exact same underlying provider and has the exact same
    // silent-failure behavior on its own catch path, so falling through to
    // it would not add real resilience, only complexity and a risk of
    // double-processing this turn. The client gets silence for this one
    // message, exactly as they would if the message were genuinely
    // unrelated — the difference is only in what gets logged.
    return { handled: false, outcome: outcome.kind };
  }

  if (outcome.kind === "UNRELATED") {
    return { handled: false, outcome: outcome.kind };
  }

  if (outcome.kind === "CLARIFY") {
    await sendOutboundMessage(params.organizationId, params.conversationId, outcome.question, "ai", "manual", undefined, true);
    return { handled: true, outcome: outcome.kind };
  }

  if (outcome.kind === "ESCALATE") {
    await handlePotentialReviewQuestion({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      clientQuestion: params.messageText,
      category: outcome.category,
      relatedRequirementId: null,
      understoodContext: { relatedRequirementName: null, gist: outcome.gist || params.messageText },
    });
    return { handled: true, outcome: outcome.kind };
  }

  if (outcome.kind === "ANSWER") {
    const pool = buildGroundedFactPool(context);
    const validatedFacts = pool.filter((f) => outcome.groundedOn.includes(f.id));
    const text = await composeGroundedAnswer(params.messageText, validatedFacts);
    await sendOutboundMessage(params.organizationId, params.conversationId, text, "ai", "manual", undefined, true);
    return { handled: true, outcome: outcome.kind };
  }

  // ACT — the only branch that can mutate the DB, and only after
  // validateAndExecuteAction's own deterministic checks.
  const actResult = await validateAndExecuteAction({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
    messageText: params.messageText,
    action: outcome.action,
    confidence: outcome.confidence,
    context,
  });
  return { handled: actResult.handled, outcome: outcome.kind };
}
