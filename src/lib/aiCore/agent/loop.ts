import { generateText, streamText, stepCountIs } from "ai";
import { getOrganization } from "@/lib/data/organizations";
import { buildToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { resolveModelInfo } from "../providers/resolveModel";
import type { AiProvider } from "../providers/types";
import { buildSystemPrompt } from "./systemPrompt";
import { trimHistoryForContext } from "./contextWindow";
import { appendAssistantTurn, appendUserMessage, loadConversationHistory } from "../memory/persistence";

// Reason -> call tools -> continue reasoning -> ... up to this many
// steps before the SDK forces a stop, regardless of whether the model
// would have kept calling tools. A hard ceiling on cost/latency per
// turn, not a product-shaped limit — 8 real tool calls covers any
// question this milestone's read-only tool set can answer.
const MAX_AGENT_STEPS = 8;

export interface RunAgentTurnInput {
  organizationId: string;
  actingUserId: string;
  actingUserName: string | null;
  actingUserEmail: string;
  conversationId: string;
  userMessage: string;
  // Per-conversation override of the configured default provider.
  provider?: AiProvider;
}

// Shared by both entry points below: persist the user's message first
// (so it's saved even if the model call itself fails), then assemble
// everything the model call needs. organizationId/getOrganization run
// alongside resolveModelInfo rather than after it, since neither depends
// on the other.
async function prepareTurn(input: RunAgentTurnInput) {
  const ctx: ToolContext = { organizationId: input.organizationId, actingUserId: input.actingUserId };

  await appendUserMessage(input.conversationId, input.organizationId, input.userMessage);

  const [rawHistory, organization, resolved] = await Promise.all([
    loadConversationHistory(input.conversationId),
    getOrganization(input.organizationId),
    resolveModelInfo(input.provider),
  ]);

  const systemPrompt = buildSystemPrompt({
    organizationName: organization?.name ?? "Centro",
    businessCategory: organization?.businessCategory ?? null,
    workflowType: organization?.workflowType ?? null,
    actingUserName: input.actingUserName,
    actingUserEmail: input.actingUserEmail,
  });

  return {
    ...resolved,
    systemPrompt,
    history: trimHistoryForContext(rawHistory),
    tools: buildToolRegistry(ctx),
  };
}

// Non-streaming — used by verification scripts and any future non-UI
// caller (e.g. a scheduled digest). Persists the full trace (via the
// SDK's own responseMessages, never hand-reconstructed) after the call
// completes.
export async function runAgentTurn(input: RunAgentTurnInput): Promise<{ replyText: string }> {
  const { model, provider, modelId, systemPrompt, history, tools } = await prepareTurn(input);

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: history,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
  });

  await appendAssistantTurn(input.conversationId, input.organizationId, result.responseMessages, {
    provider,
    modelId,
    usage: result.usage,
    finishReason: result.finishReason,
  });

  return { replyText: result.text };
}

// Streaming — the UI path (src/app/api/assistant/chat/route.ts).
// Persistence happens in onFinish, which fires once the full multi-step
// run completes server-side, so a dropped client connection still saves
// the exchange.
export async function streamAgentTurn(input: RunAgentTurnInput) {
  const { model, provider, modelId, systemPrompt, history, tools } = await prepareTurn(input);

  return streamText({
    model,
    system: systemPrompt,
    messages: history,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    onFinish: async (result) => {
      await appendAssistantTurn(input.conversationId, input.organizationId, result.responseMessages, {
        provider,
        modelId,
        usage: result.usage,
        finishReason: result.finishReason,
      });
    },
  });
}
