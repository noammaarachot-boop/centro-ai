/**
 * Ch.9 Intent Detection — mocked (no LLM provider is configured for this
 * pilot). Real implementation sends the message to an LLM with the five
 * category labels; this uses deterministic keyword rules with the exact
 * same return type, so swapping it out later is contained to this file.
 * Only "collection_related" is meant to ever drive workflow automation
 * (Ch.9: "Only Collection Related messages may trigger workflow
 * automation") — everything else stays in history without changing state.
 */
export type MessageIntent =
  | "collection_related"
  | "professional_question"
  | "general_conversation"
  | "greeting"
  | "unknown";

const GREETING_WORDS = [
  "שלום",
  "היי",
  "בוקר טוב",
  "ערב טוב",
  "hi",
  "hello",
  "hey",
];

const COLLECTION_KEYWORDS = [
  "מסמך",
  "מסמכים",
  "קובץ",
  "צירפתי",
  "שולח",
  "שלחתי",
  "attach",
  "document",
  "file",
  "pdf",
];

const QUESTION_MARKERS = ["?", "מתי", "איך", "למה", "כמה", "האם"];

export async function classifyIntent(body: string): Promise<MessageIntent> {
  const trimmed = body.trim();
  if (!trimmed) return "unknown";
  const lower = trimmed.toLowerCase();

  if (trimmed.length <= 25 && GREETING_WORDS.some((w) => lower.includes(w))) {
    return "greeting";
  }
  if (COLLECTION_KEYWORDS.some((w) => lower.includes(w))) {
    return "collection_related";
  }
  if (QUESTION_MARKERS.some((q) => trimmed.includes(q))) {
    return "professional_question";
  }
  return "general_conversation";
}
