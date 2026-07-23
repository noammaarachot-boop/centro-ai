import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiConversations, aiMessages } from "@/db/schema";
import type { ModelMessage } from "ai";

// Every function here takes organizationId (and, for reads/writes tied
// to a specific conversation, implicitly trusts conversationId only
// after it was already resolved through getConversation/listConversations,
// which scope by both organizationId and userId) — mirrors
// getOrgScopedCollectionRequest's discipline throughout
// src/app/(app)/collections/actions.ts.

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

// `parts` holds only the message's `content` (string, or an array of
// text/tool-call/tool-result parts) — `role` lives in its own column, so
// it's never duplicated between the two. `content` here is a display-only
// projection: the concatenation of any text parts, or the string itself.
// Null for a role="tool" row or a tool-call-only assistant row.
function extractDisplayText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      )
      .map((part) => part.text)
      .join("");
    return text || null;
  }
  return null;
}

// Private to this employee — mirrors how a personal AI assistant's
// history isn't automatically visible to coworkers. Today's pilot has
// exactly one user per organization (see aiConversations.userId's own
// schema comment), so this doesn't yet change observable behavior, but
// costs nothing to get right now.
export async function createConversation(organizationId: string, userId: string) {
  const db = await getDb();
  const [conversation] = await db.insert(aiConversations).values({ organizationId, userId }).returning();
  return conversation;
}

export async function listConversations(organizationId: string, userId: string) {
  const db = await getDb();
  return db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.organizationId, organizationId), eq(aiConversations.userId, userId)))
    .orderBy(desc(aiConversations.updatedAt));
}

export async function getConversation(organizationId: string, userId: string, conversationId: string) {
  const db = await getDb();
  const [conversation] = await db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.organizationId, organizationId),
        eq(aiConversations.userId, userId)
      )
    )
    .limit(1);
  return conversation ?? null;
}

// Reconstructs the exact ModelMessage[] shape the provider SDK expects
// for the next turn's `messages` param — lossless, since `parts` already
// holds the verbatim content the SDK itself produced or consumed.
export async function loadConversationHistory(conversationId: string): Promise<ModelMessage[]> {
  const db = await getDb();
  const rows = await db
    .select({ role: aiMessages.role, parts: aiMessages.parts })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt));
  return rows.map((row) => ({ role: row.role, content: row.parts }) as ModelMessage);
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

// For initial page-load rendering only (AssistantChat's `initialMessages`
// prop) — a deliberately simplified projection of the full trace: only
// user/assistant rows with real display text, skipping pure tool-call/
// tool-result rows entirely. The live/streaming session still shows real
// tool activity as it happens; this only affects what a fresh page
// reload replays, and a correct, honest simplification (show the real
// questions and real final answers) beats a half-reconstructed replay of
// intermediate tool-call bubbles from persisted data.
export async function listMessagesForDisplay(conversationId: string): Promise<DisplayMessage[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: aiMessages.id, role: aiMessages.role, content: aiMessages.content })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt));
  return rows
    .filter((row): row is { id: string; role: "user" | "assistant"; content: string } =>
      (row.role === "user" || row.role === "assistant") && !!row.content
    )
    .map((row) => ({ id: row.id, role: row.role, text: row.content }));
}

export async function appendUserMessage(
  conversationId: string,
  organizationId: string,
  text: string
): Promise<void> {
  const db = await getDb();
  const [conversation] = await db
    .select({ title: aiConversations.title })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId))
    .limit(1);

  await db.insert(aiMessages).values({
    organizationId,
    conversationId,
    role: "user",
    content: text,
    parts: text,
  });

  await db
    .update(aiConversations)
    .set({
      updatedAt: new Date(),
      ...(conversation && !conversation.title ? { title: deriveTitle(text) } : {}),
    })
    .where(eq(aiConversations.id, conversationId));
}

export interface AssistantTurnMessage {
  role: "assistant" | "tool";
  content: unknown;
}

export interface AppendAssistantTurnMeta {
  provider?: string;
  modelId?: string;
  usage?: unknown;
  finishReason?: string;
}

// `newMessages` is the SDK's own `responseMessages` from this turn's
// result — one row per message, not per turn (see aiMessages' own
// schema comment: a tool-calling turn produces an assistant row plus one
// or more tool rows before any final text).
export async function appendAssistantTurn(
  conversationId: string,
  organizationId: string,
  newMessages: AssistantTurnMessage[],
  meta: AppendAssistantTurnMeta
): Promise<void> {
  if (newMessages.length === 0) return;
  const db = await getDb();

  await db.insert(aiMessages).values(
    newMessages.map((message) => ({
      organizationId,
      conversationId,
      role: message.role,
      content: extractDisplayText(message.content),
      parts: message.content,
      provider: message.role === "assistant" ? (meta.provider ?? null) : null,
      modelId: message.role === "assistant" ? (meta.modelId ?? null) : null,
      metadata:
        message.role === "assistant" ? { usage: meta.usage ?? null, finishReason: meta.finishReason ?? null } : null,
    }))
  );

  await db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
}
