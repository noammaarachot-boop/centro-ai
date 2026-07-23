import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getConversation } from "@/lib/aiCore/memory/persistence";
import { streamAgentTurn } from "@/lib/aiCore/agent/loop";

export const dynamic = "force-dynamic";

// Process-local, in-memory rate limiting — this route has exactly one call
// site, so a small dedicated Map here (rather than a shared/parameterized
// module) matches src/app/api/contact/route.ts's precedent. Keyed per
// employee (not IP): the thing being bounded is real per-turn LLM provider
// cost, which scales with how many turns one signed-in employee can trigger,
// not with request origin. Same "single pilot instance" caveat as
// src/lib/auth/rateLimiter.ts — revisit with a shared store if this ever
// runs as multiple instances.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_TURNS = 20;
const turnsByUser = new Map<string, { count: number; firstAt: number }>();

function isRateLimited(userId: string): boolean {
  const entry = turnsByUser.get(userId);
  if (!entry || Date.now() - entry.firstAt > RATE_WINDOW_MS) {
    turnsByUser.set(userId, { count: 1, firstAt: Date.now() });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_TURNS;
}

interface UIMessagePart {
  type: string;
  text?: string;
}
interface IncomingUIMessage {
  role: string;
  parts?: UIMessagePart[];
}

function latestUserMessageText(messages: IncomingUIMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  const text = (last.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text || null;
}

// The Copilot's chat endpoint (AssistantChat.tsx's useChat() posts here).
// useChat's DefaultChatTransport sends the client's full running message
// list on every request, not just the new one — the agent loop doesn't
// need that (it loads real history from ai_messages itself), so this
// only ever reads the last message's text out of it.
export async function POST(request: NextRequest) {
  const session = await requireSession();

  if (isRateLimited(session.userId)) {
    return NextResponse.json(
      { error: "יותר מדי הודעות בזמן קצר. נסו שוב בעוד כמה דקות." },
      { status: 429 }
    );
  }

  const body = (await request.json()) as { conversationId?: string; messages?: IncomingUIMessage[] };

  const conversationId = body.conversationId;
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  // Org+user-scoped, exactly like the page itself — a conversationId the
  // client supplies must never be trusted without this check.
  const conversation = await getConversation(session.organizationId, session.userId, conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const userMessage = latestUserMessageText(body.messages ?? []);
  if (!userMessage) {
    return NextResponse.json({ error: "no user message" }, { status: 400 });
  }

  const result = await streamAgentTurn({
    organizationId: session.organizationId,
    actingUserId: session.userId,
    actingUserName: session.fullName,
    actingUserEmail: session.email,
    conversationId,
    userMessage,
  });

  return result.toUIMessageStreamResponse();
}
