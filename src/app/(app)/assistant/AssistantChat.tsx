"use client";

import { useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Send, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";

// Assistant replies are always markdown-formatted (bold, lists — every
// model does this by convention) — found via live testing that plain-
// text rendering showed the raw `**asterisks**` literally. No prose
// plugin is installed in this codebase, so element styling is set here
// directly rather than adding @tailwindcss/typography for one surface.
const MARKDOWN_COMPONENTS = {
  p: (props: React.ComponentPropsWithoutRef<"p">) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className="mb-2 list-disc space-y-0.5 pe-4 last:mb-0" {...props} />
  ),
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className="mb-2 list-decimal space-y-0.5 pe-4 last:mb-0" {...props} />
  ),
  strong: (props: React.ComponentPropsWithoutRef<"strong">) => <strong className="font-bold" {...props} />,
  a: (props: React.ComponentPropsWithoutRef<"a">) => (
    <a className="underline underline-offset-2" target="_blank" rel="noopener noreferrer" {...props} />
  ),
  code: (props: React.ComponentPropsWithoutRef<"code">) => (
    <code className="rounded bg-black/10 px-1 py-0.5 text-[0.85em]" {...props} />
  ),
};

export interface InitialChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

// Bubble styling deliberately reuses collections/[id]/page.tsx's exact
// existing chat classes (centro-ai-gradient for AI messages, bg-brand-
// purple/10 for outbound/user) — this app's one other real chat surface
// — rather than inventing a new visual language for a second chat UI.
export function AssistantChat({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: InitialChatMessage[];
}) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    messages: initialMessages.map((m) => ({ id: m.id, role: m.role, parts: [{ type: "text" as const, text: m.text }] })),
    transport: new DefaultChatTransport({
      api: "/api/assistant/chat",
      body: { conversationId },
    }),
  });

  const isBusy = status === "submitted" || status === "streaming";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-6">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-text-muted">
            <Sparkles className="h-8 w-8 text-brand-purple/50" />
            <p className="text-sm">
              שאלו את Centro AI על הלקוחות, בקשות האיסוף, או כל דבר אחר במשרד.
            </p>
          </div>
        )}

        {messages.map((message) => {
          const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (!text) return null; // tool-call-only assistant steps render nothing today — see AssistantChat's own doc comment below

          const isAssistant = message.role === "assistant";
          return (
            <div
              key={message.id}
              className={
                isAssistant
                  ? "centro-ai-gradient me-auto max-w-[80%] rounded-2xl rounded-ss-sm px-4 py-2.5 text-sm text-white"
                  : "ms-auto max-w-[80%] rounded-2xl rounded-se-sm bg-brand-purple/10 px-4 py-2.5 text-sm text-text-primary whitespace-pre-wrap"
              }
            >
              {isAssistant ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                  {text}
                </ReactMarkdown>
              ) : (
                text
              )}
            </div>
          );
        })}

        {status === "submitted" && (
          <div className="centro-ai-gradient me-auto flex max-w-[80%] items-center gap-2 rounded-2xl rounded-ss-sm px-4 py-2.5 text-sm text-white">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            חושב...
          </div>
        )}
      </div>

      {/* pl-20 (physical, not the logical ps-*) is deliberate — clears
          the globally fixed AccessibilityWidget (bottom-5/6 left-5/6,
          h-14 w-14, src/app/layout.tsx) so this bar's own send button,
          which lands at the physical left end of this RTL flex row,
          never renders underneath it. Same class of physical-vs-logical
          fix FloatingWhatsAppButton's own placement already established
          for the identical widget. */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border p-4 pl-20">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="שאלו משהו..."
          disabled={isBusy}
          className="flex-1 rounded-full border border-border bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-all focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={isBusy || !input.trim()}
          className={buttonVariants({ variant: "primary", size: "icon" })}
          aria-label="שליחה"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}
