import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, documents } from "@/db/schema";
import { computeRequirementSatisfaction } from "@/lib/documentQuantity";
import { SUPPORTED_EXTENSIONS } from "@/lib/ai/documentClassifier";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

/**
 * Conversational Q&A — Centro answers a client's question about their own
 * active document request strictly from what's actually stored: the office
 * user's own parsed requirement (RequirementSemanticSpec) and the request's
 * real document status. Every function here is a pure, deterministic
 * renderer — no free-form generation of facts, ever. See
 * src/lib/ai/requestMessageIntent.ts for the (AI-driven) classification of
 * *which* question is being asked; this module only ever decides *what the
 * true answer is*, from data.
 */

// A small, deliberately narrow map — Hebrew plural forms aren't
// mechanically derivable, and guessing one wrong reads worse than falling
// back to the singular. Covers the document types this app's own templates
// most commonly produce; anything else degrades gracefully to "3 <singular>"
// (understandable, if not perfectly grammatical) rather than inventing a
// plural form that might be wrong.
const PLURAL_MAP: Record<string, string> = {
  "תלוש שכר": "תלושי שכר",
  "תעודת זהות": "תעודות זהות",
  חשבונית: "חשבוניות",
  אישור: "אישורים",
  "אישור שכירות": "אישורי שכירות",
  דוח: "דוחות",
  'דו"ח': "דוחות",
  רישיון: "רישיונות",
  חוזה: "חוזים",
  "דף חשבון": "דפי חשבון",
  קבלה: "קבלות",
};

function pluralize(docType: string): string {
  return PLURAL_MAP[docType.trim()] ?? docType;
}

const MONTH_NAMES_HE = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

// "06/2026" or a bare "06" -> "יוני". Anything malformed is returned
// untouched rather than guessed.
export function formatPeriodEntryLabel(entry: string): string {
  const monthStr = entry.length >= 2 ? entry.slice(0, 2) : entry;
  const month = Number.parseInt(monthStr, 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) return entry;
  return MONTH_NAMES_HE[month - 1];
}

// The core deterministic renderer — turns a requirement's already-parsed
// spec into a short, natural Hebrew phrase describing exactly what was
// asked for, no more and no less. Never invents a rule the office user
// didn't state: a requirement with no spec (legacy/ad-hoc) just returns its
// own stored name verbatim.
export function describeRequirement(name: string, requiredCount: number, spec: RequirementSemanticSpec | null): string {
  if (!spec) return name;
  const docType = spec.documentType?.trim() || name;
  const countPhrase = requiredCount > 1 ? `${requiredCount} ${pluralize(docType)}` : docType;

  let periodPhrase = "";
  if (spec.periodType === "relative" && spec.relativePeriod) {
    periodPhrase = spec.distinctPeriodsRequired
      ? `, אחד מכל אחד מ-${spec.relativePeriod.n} החודשים האחרונים`
      : ` מ-${spec.relativePeriod.n} החודשים האחרונים`;
  } else if (spec.periodType === "explicit" && spec.explicitPeriods && spec.explicitPeriods.length > 0) {
    const monthLabels = spec.explicitPeriods.map(formatPeriodEntryLabel);
    periodPhrase =
      spec.distinctPeriodsRequired && !spec.samePeriodAllowed
        ? `, אחד מכל אחד מהחודשים: ${monthLabels.join(", ")}`
        : ` של חודש ${monthLabels.join(", ")}`;
  }

  const peoplePhrase = spec.distinctPeopleRequired ? ", לאנשים שונים" : "";
  return `${countPhrase}${periodPhrase}${peoplePhrase}`.trim();
}

export interface RequirementFact {
  id: string;
  description: string;
  requiredCount: number;
  satisfiedCount: number;
  satisfied: boolean;
  supportingDocumentRelationship: string | null;
}

// The single DB read every category below is rendered from — one pass over
// this request's real requirements and real approved documents, exactly the
// same satisfaction logic checkCompletionGate itself uses (never a separate,
// looser "just for chat" approximation).
export async function buildRequirementFacts(collectionRequestId: string): Promise<RequirementFact[]> {
  const db = await getDb();
  const requirements = await db
    .select({
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
      requiredCount: collectionRequestRequirements.requiredCount,
      semanticSpec: collectionRequestRequirements.semanticSpec,
      exceptionStatus: collectionRequestRequirements.exceptionStatus,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, collectionRequestId));

  const approvedDocs = await db
    .select({
      requirementId: documents.requirementId,
      extractedPeriodLabel: documents.extractedPeriodLabel,
      extractedPersonName: documents.extractedPersonName,
      continuationOfDocumentId: documents.continuationOfDocumentId,
    })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), eq(documents.status, "approved")));

  return requirements.map((requirement) => {
    const spec = requirement.semanticSpec as RequirementSemanticSpec | null;
    const docs = approvedDocs
      .filter((doc) => doc.requirementId === requirement.id && !doc.continuationOfDocumentId)
      .map((doc) => ({ periodLabel: doc.extractedPeriodLabel, personName: doc.extractedPersonName }));
    const { satisfiedCount, satisfied } = computeRequirementSatisfaction(requirement, docs);
    return {
      id: requirement.id,
      description: describeRequirement(requirement.name, requirement.requiredCount, spec),
      requiredCount: requirement.requiredCount,
      satisfiedCount,
      satisfied,
      supportingDocumentRelationship: spec?.supportingDocumentRelationship ?? null,
    };
  });
}

export function renderOverviewAnswer(facts: RequirementFact[]): string {
  if (facts.length === 0) {
    return "לא נמצאה כרגע רשימת מסמכים פעילה עבור הבקשה הזו.";
  }
  const lines = facts.map((f) => {
    if (f.satisfied) return `✅ ${f.description} — התקבל, תודה`;
    if (f.satisfiedCount > 0) return `⏳ ${f.description} — התקבלו ${f.satisfiedCount} מתוך ${f.requiredCount}`;
    return `◻️ ${f.description} — טרם התקבל`;
  });
  return `הנה מה שביקשנו:\n${lines.join("\n")}`;
}

export interface RecentDocumentFact {
  status: string;
  requirementDescription: string | null;
}

const RECEIPT_STATUS_LABELS: Record<string, string> = {
  approved: "התקבל ואושר",
  processing: "התקבל, בעיבוד",
  needs_review: "התקבל, בבדיקה שלנו",
  unsolicited_pending_confirmation: "התקבל, ממתין לאישורך",
  clarification_requested: "התקבל, וחיכינו שתבהיר/י מה זה",
  identity_anomaly_pending_confirmation: "התקבל, ממתין לאישורך",
};

// Only the request's own approved documents carry a describable
// requirement — anything still pending some other decision (unsolicited,
// clarification, identity anomaly) has no requirementId at all yet, so the
// answer names only the document's status, not a requirement it doesn't
// (yet) belong to.
export async function buildMostRecentDocumentFact(collectionRequestId: string): Promise<RecentDocumentFact | null> {
  const db = await getDb();
  const [latest] = await db
    .select({
      status: documents.status,
      requirementId: documents.requirementId,
    })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId))
    .orderBy(desc(documents.receivedAt))
    .limit(1);
  if (!latest) return null;

  let requirementDescription: string | null = null;
  if (latest.requirementId) {
    const [requirement] = await db
      .select({
        name: collectionRequestRequirements.name,
        requiredCount: collectionRequestRequirements.requiredCount,
        semanticSpec: collectionRequestRequirements.semanticSpec,
      })
      .from(collectionRequestRequirements)
      .where(eq(collectionRequestRequirements.id, latest.requirementId))
      .limit(1);
    if (requirement) {
      requirementDescription = describeRequirement(
        requirement.name,
        requirement.requiredCount,
        requirement.semanticSpec as RequirementSemanticSpec | null
      );
    }
  }
  return { status: latest.status, requirementDescription };
}

export function renderReceiptCheckAnswer(fact: RecentDocumentFact | null): string {
  if (!fact) return "עדיין לא התקבל אצלנו שום מסמך בבקשה הזו.";
  const statusLabel = RECEIPT_STATUS_LABELS[fact.status] ?? "התקבל";
  return fact.requirementDescription ? `כן, ${statusLabel} (${fact.requirementDescription}).` : `כן, ${statusLabel}.`;
}

export function renderSupportingDocumentAnswer(facts: RequirementFact[]): string {
  const withSupporting = facts.filter((f) => f.supportingDocumentRelationship);
  if (withSupporting.length === 0) {
    return "לא צוינה דרישה למסמך נלווה/ספח בבקשה הזו.";
  }
  return withSupporting.map((f) => `לגבי ${f.description}: ${f.supportingDocumentRelationship}`).join("\n");
}

export function renderFileFormatAnswer(): string {
  return `אפשר לשלוח בכל אחד מהפורמטים: ${SUPPORTED_EXTENSIONS.map((ext) => ext.toUpperCase()).join(", ")}.`;
}

// The single entry point the webhook route calls for every category this
// module can answer on its own (everything except "no_document_exception"
// and "unrelated", which src/lib/requirementException.ts and the route
// itself handle respectively). Every branch reads only real, current data —
// never generates a fact that isn't already stored.
export async function answerRequestMessage(
  category: "request_overview" | "receipt_check" | "supporting_document" | "file_format",
  collectionRequestId: string
): Promise<string> {
  if (category === "receipt_check") {
    return renderReceiptCheckAnswer(await buildMostRecentDocumentFact(collectionRequestId));
  }
  const facts = await buildRequirementFacts(collectionRequestId);
  if (category === "supporting_document") return renderSupportingDocumentAnswer(facts);
  if (category === "file_format") return renderFileFormatAnswer();
  return renderOverviewAnswer(facts);
}
