import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getConversation } from "@/lib/aiCore/memory/persistence";
import { streamAgentTurn } from "@/lib/aiCore/agent/loop";

export const dynamic = "force-dynamic";

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
