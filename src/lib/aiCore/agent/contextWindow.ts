import type { ModelMessage } from "ai";

// V1: a simple, correct sliding window — keep the most recent N
// messages, trimming only whole messages from the oldest end, never
// splitting a tool-call/tool-result pair (which would corrupt what the
// provider sees on the next turn, since a "tool" message with no
// preceding matching "assistant" tool-call is invalid). Deliberately NOT
// a vector/embeddings retrieval system — matches this codebase's
// established pattern (src/lib/ai/*) of shipping a genuinely correct,
// simple V1 with a documented real seam, rather than building retrieval
// infrastructure with no product signal yet that it's needed. If
// conversations regularly exceed this window in practice, the documented
// future upgrade (provider-native compaction, or a real RAG layer) is
// isolated to this one file.
const MAX_HISTORY_MESSAGES = 40;

export function trimHistoryForContext(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  let cut = messages.length - MAX_HISTORY_MESSAGES;
  while (cut > 0 && messages[cut].role === "tool") cut -= 1;
  return messages.slice(cut);
}
