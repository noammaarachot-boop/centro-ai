"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { fieldClass } from "@/components/app/FormField";
import { createManualTemplate } from "../actions";

// Smart Profession-Aware Onboarding (item 3) — "I want to create my own
// templates," shared by Step 4 (Import) and Step 5 (Analysis) so it's a
// persistent option throughout the Excel/AI path, never a fork that
// replaces it. Deliberately just a name — no AI-suggested requirements;
// documents are added per type on Step 6, exactly like any other type.
export function ManualTemplateCreator({
  existingTypes,
}: {
  existingTypes: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      {existingTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {existingTypes.map((t) => (
            <span
              key={t.id}
              className="rounded-full border border-border bg-surface-muted/50 px-2.5 py-1 text-xs text-text-secondary"
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-purple hover:underline"
        >
          <Plus className="h-3.5 w-3.5" />
          צור תבנית משלכם
        </button>
      ) : (
        <form action={createManualTemplate} className="flex flex-wrap items-center gap-2">
          <input
            name="name"
            type="text"
            required
            autoFocus
            placeholder="שם התבנית, לדוגמה: לקוח VIP"
            className={fieldClass("sm", "flex-1")}
          />
          <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            יצירה
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-text-muted hover:underline"
          >
            ביטול
          </button>
        </form>
      )}
    </div>
  );
}
