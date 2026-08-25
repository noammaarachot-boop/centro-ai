"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Send, Loader2 } from "lucide-react";
import type { SendMessageState } from "@/app/(app)/collections/conversationActions";

// The employee's way to send a real WhatsApp message to the client from
// inside the request screen.
//
// The send itself is unchanged — this calls the same server action as
// before. What it adds is the part that was missing: the previous composer
// was a bare input and button with no pending state at all, so a slow send
// looked like nothing had happened and a second click sent the message
// twice.

function SendButton({ disabled }: { disabled: boolean }) {
  // useFormStatus reads the pending state of the enclosing <form>, which is
  // what makes this work without tracking submission state by hand.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-brand-purple px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-purple-deep disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Send className="h-4 w-4" aria-hidden="true" />
      )}
      <span>{pending ? "שולח…" : "שליחה"}</span>
    </button>
  );
}

function ComposerField({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const { pending } = useFormStatus();
  return (
    <input
      ref={inputRef}
      name="body"
      type="text"
      required
      autoComplete="off"
      disabled={pending}
      placeholder="כתוב הודעה…"
      aria-label="הודעה ללקוח"
      // h-11 keeps the field at a comfortable touch target on a phone.
      className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-purple disabled:opacity-60"
    />
  );
}

export function MessageComposer({
  action,
}: {
  action: (state: SendMessageState, formData: FormData) => Promise<SendMessageState>;
}) {
  const [state, formAction] = useActionState<SendMessageState, FormData>(action, {});
  const inputRef = useRef<HTMLInputElement>(null);

  // A successful send redirects and re-renders the page, so the sent message
  // simply appears in the thread above. Clearing here covers the case where
  // the component is reused without a full remount.
  useEffect(() => {
    if (!state.error && inputRef.current) inputRef.current.value = "";
  }, [state]);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <form action={formAction} className="flex items-end gap-2">
        <ComposerField inputRef={inputRef} />
        <SendButton disabled={false} />
      </form>
      {state.error && (
        <p role="alert" className="mt-2 text-xs font-medium text-danger">
          {state.error}
        </p>
      )}
      <p className="mt-2 text-xs text-text-muted">
        ההודעה תישלח ללקוח ב-WhatsApp ותופיע בשיחה למעלה.
      </p>
    </div>
  );
}
