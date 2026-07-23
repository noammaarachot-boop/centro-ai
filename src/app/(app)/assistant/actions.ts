"use server";

import { eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { aiConversations } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { createConversation } from "@/lib/aiCore/memory/persistence";

export async function createConversationAction() {
  const session = await requireSession();
  const conversation = await createConversation(session.organizationId, session.userId);
  redirect(`/assistant/${conversation.id}`);
}

export async function renameConversationAction(conversationId: string, formData: FormData) {
  const session = await requireSession();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    refresh();
    return;
  }

  const db = await getDb();
  await db
    .update(aiConversations)
    .set({ title, updatedAt: new Date() })
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.organizationId, session.organizationId),
        eq(aiConversations.userId, session.userId)
      )
    );

  refresh();
}

export async function archiveConversationAction(conversationId: string) {
  const session = await requireSession();

  const db = await getDb();
  await db
    .update(aiConversations)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.organizationId, session.organizationId),
        eq(aiConversations.userId, session.userId)
      )
    );

  redirect("/assistant");
}
