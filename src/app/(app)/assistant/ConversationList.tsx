import Link from "next/link";
import { clsx } from "clsx";
import { Plus, Archive } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { createConversationAction, archiveConversationAction } from "./actions";

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: Date;
}

// Mirrors Sidebar.tsx's own nav-link active-state pattern (gradient
// background + accent bar for the current item) for visual consistency,
// scoped to just this route's own sub-navigation rather than the app's
// primary nav.
export function ConversationList({
  conversations,
  activeConversationId,
}: {
  conversations: ConversationSummary[];
  activeConversationId: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <form action={createConversationAction}>
          <button
            type="submit"
            className={buttonVariants({ variant: "secondary", size: "sm", className: "w-full justify-center" })}
          >
            <Plus className="h-3.5 w-3.5" />
            שיחה חדשה
          </button>
        </form>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {conversations.map((conversation) => {
          const active = conversation.id === activeConversationId;
          return (
            <div
              key={conversation.id}
              className={clsx(
                "group relative flex items-center gap-1 rounded-xl px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-gradient-to-l from-brand-purple/10 to-brand-blue/5 text-brand-purple"
                  : "text-text-secondary hover:bg-surface-muted hover:text-text-primary"
              )}
            >
              {active && (
                <span className="absolute inset-y-1 end-0 w-0.5 rounded-full bg-gradient-to-b from-brand-purple to-brand-blue" />
              )}
              <Link href={`/assistant/${conversation.id}`} className="min-w-0 flex-1 truncate font-medium">
                {conversation.title || "שיחה חדשה"}
              </Link>
              <form action={archiveConversationAction.bind(null, conversation.id)}>
                <button
                  type="submit"
                  aria-label="העברה לארכיון"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-text-muted opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </form>
            </div>
          );
        })}
        {conversations.length === 0 && (
          <p className="px-3 py-2 text-xs text-text-muted">אין עדיין שיחות קודמות.</p>
        )}
      </nav>
    </div>
  );
}
