import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { createConversation, listConversations } from "@/lib/aiCore/memory/persistence";

// Entry point for the sidebar's "עוזר AI" link — no conversation id yet,
// so this resolves one: the most recently active conversation if the
// employee has any, or a brand new one otherwise, then redirects to the
// real page. Keeps [conversationId]/page.tsx as the only place that
// actually renders the chat.
export default async function AssistantIndexPage() {
  const session = await requireSession();

  const conversations = await listConversations(session.organizationId, session.userId);
  const conversation = conversations[0] ?? (await createConversation(session.organizationId, session.userId));

  redirect(`/assistant/${conversation.id}`);
}
