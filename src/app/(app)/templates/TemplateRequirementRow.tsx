"use client";

import { useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  moveRequirementDown,
  moveRequirementUp,
  removeTemplateRequirement,
  renameTemplateRequirement,
} from "./actions";

// Rename auto-submits on blur (save when you're done editing, no separate
// button) — needs a client component since onBlur is a DOM event handler,
// which a Server Component's static output can't carry. Move up/down and
// remove stay plain <form action> submits, same as the rest of this app.
export function TemplateRequirementRow({
  templateId,
  requirementId,
  name,
  isFirst,
  isLast,
}: {
  templateId: string;
  requirementId: string;
  name: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const boundMoveUp = moveRequirementUp.bind(null, templateId, requirementId);
  const boundMoveDown = moveRequirementDown.bind(null, templateId, requirementId);
  const boundRename = renameTemplateRequirement.bind(null, templateId, requirementId);
  const boundRemove = removeTemplateRequirement.bind(null, templateId, requirementId);

  return (
    <li className="flex items-center gap-2 rounded-xl border border-border bg-surface-muted/40 px-3 py-2 transition-colors hover:border-brand-purple/20">
      <div className="flex shrink-0 flex-col">
        <form action={boundMoveUp}>
          <button
            type="submit"
            disabled={isFirst}
            aria-label="הזזה למעלה"
            className="grid h-5 w-5 place-items-center rounded text-text-muted transition-colors hover:bg-surface hover:text-brand-purple disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        </form>
        <form action={boundMoveDown}>
          <button
            type="submit"
            disabled={isLast}
            aria-label="הזזה למטה"
            className="grid h-5 w-5 place-items-center rounded text-text-muted transition-colors hover:bg-surface hover:text-brand-purple disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>

      <RenameForm action={boundRename} originalName={name} />

      <form action={boundRemove}>
        <button
          type="submit"
          className="inline-flex shrink-0 items-center gap-1 px-2 text-xs font-medium text-danger transition-colors hover:underline"
        >
          <X className="h-3 w-3" />
          הסרה
        </button>
      </form>
    </li>
  );
}

// Only submits on blur if the value actually changed — an onBlur that
// fires unconditionally would write a no-op update and a misleading audit
// event ("name changed") every time someone merely clicks into and back
// out of the field.
function RenameForm({
  action,
  originalName,
}: {
  action: (formData: FormData) => void;
  originalName: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={action} className="min-w-0 flex-1">
      <input
        name="name"
        type="text"
        defaultValue={originalName}
        onBlur={(e) => {
          if (e.currentTarget.value.trim() && e.currentTarget.value !== originalName) {
            formRef.current?.requestSubmit();
          }
        }}
        aria-label={`שם המסמך: ${originalName}`}
        className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm font-medium text-text-primary outline-none transition-colors hover:border-border focus:border-brand-purple focus:bg-white"
      />
    </form>
  );
}
