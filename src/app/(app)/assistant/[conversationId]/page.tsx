import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getConversation, listConversations, listMessagesForDisplay } from "@/lib/aiCore/memory/persistence";
import { PageHeader } from "@/components/app/PageHeader";
import { ConversationList } from "../ConversationList";
import { AssistantChat } from "../AssistantChat";

export default async function AssistantConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const session = await requireSession();

  // Scoped by organizationId AND userId (mirrors getOrgScopedCollectionRequest's
  // discipline) — a conversation belonging to another employee or
  // organization must 404, never silently redirect somewhere else.
  const conversation = await getConversation(session.organizationId, session.userId, conversationId);
  if (!conversation) notFound();

  const [conversations, initialMessages] = await Promise.all([
    listConversations(session.organizationId, session.userId),
    listMessagesForDisplay(conversationId),
  ]);

  return (
    <div className="flex h-screen flex-col px-6 py-6 lg:px-10">
      <PageHeader eyebrow="Centro AI" title={conversation.title || "שיחה חדשה"} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        <div className="centro-glass hidden rounded-2xl border border-border lg:block">
          <ConversationList conversations={conversations} activeConversationId={conversationId} />
        </div>
        <div className="centro-glass min-h-0 rounded-2xl border border-border">
          <AssistantChat conversationId={conversationId} initialMessages={initialMessages} />
        </div>
      </div>
    </div>
  );
}
