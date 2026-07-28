"use client";

import { useState } from "react";
import { buttonVariants, Button } from "@/components/app/Button";
import { fieldClass } from "@/components/app/FormField";

interface ClientRow {
  id: string;
  name: string;
  phone: string;
}

interface TemplateOption {
  id: string;
  name: string;
}

// Smart Profession-Aware Onboarding (item 4) — the bulk client-assignment
// UI, extracted out of Step5Analysis.tsx so the exact same
// filter/select-all/bulk-assign interaction serves both AI-classified
// business types and manually-created ones (Phase D's
// ManualTemplateCreator) — they're both just `businessTypes` rows, so
// there was never a need for two separate assignment UIs, only one shared
// component. Explicit "leave unassigned" is simply not selecting a client
// and closing the panel — there's no separate DB state to set for
// "unassigned," it's the default the moment nothing is chosen.
//
// Text is hardcoded to "סוג עסק" ("business type") — the term the
// surrounding Recurring-flow screens (Step 4/5/6/7/8) already use for this
// exact entity throughout. This is currently this component's only real
// caller context; if a future on-demand-flow usage needs "תבנית" instead,
// that's a real second variant to design then, not a speculative prop now.
export function ClientAssignmentPanel({
  clients,
  templates,
  assignAction,
  toggleLabel = "שיוך סוג עסק",
}: {
  clients: ClientRow[];
  templates: TemplateOption[];
  assignAction: (formData: FormData) => void | Promise<void>;
  toggleLabel?: string;
  entityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingNewType, setCreatingNewType] = useState(false);
  // Product Evolution M9's "fast and non-exhausting for hundreds of
  // clients" pattern, unchanged from the original Step 5 panel: a filter
  // narrows a long list, and "select all" always means "every currently
  // filtered client."
  const [filter, setFilter] = useState("");

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredClients = normalizedFilter
    ? clients.filter(
        (c) => c.name.toLowerCase().includes(normalizedFilter) || c.phone.includes(normalizedFilter)
      )
    : clients;
  const allFilteredSelected =
    filteredClients.length > 0 && filteredClients.every((c) => selectedIds.has(c.id));

  function toggleSelectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const c of filteredClients) next.delete(c.id);
      } else {
        for (const c of filteredClients) next.add(c.id);
      }
      return next;
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {toggleLabel}
      </button>
    );
  }

  return (
    <form
      action={assignAction}
      className="animate-fade-in-up space-y-3 rounded-xl border border-border bg-surface p-3"
    >
      {clients.length > 8 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="חיפוש לפי שם או טלפון..."
          className={fieldClass("sm")}
        />
      )}

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAllFiltered}
            className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
          />
          {normalizedFilter
            ? `בחירת כל התוצאות המסוננות (${filteredClients.length})`
            : `בחירת הכל (${filteredClients.length})`}
        </label>
        {selectedIds.size > 0 && (
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-xs font-medium text-text-muted hover:underline"
          >
            ביטול בחירה
          </button>
        )}
      </div>

      <ul className="max-h-60 space-y-1.5 overflow-y-auto">
        {filteredClients.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                name="clientId"
                value={c.id}
                checked={selectedIds.has(c.id)}
                onChange={() => toggleSelected(c.id)}
                className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
              />
              {c.name} <span dir="ltr" className="text-text-muted">({c.phone})</span>
            </label>
          </li>
        ))}
        {filteredClients.length === 0 && (
          <li className="text-xs text-text-muted">אין לקוחות תואמים לחיפוש.</li>
        )}
      </ul>

      {/* Selected clients outside the current filter must still submit —
          the checkboxes above only render the filtered subset, so their
          hidden values here keep any previously-selected-then-filtered-out
          client in the submitted form data too. */}
      {[...selectedIds]
        .filter((id) => !filteredClients.some((c) => c.id === id))
        .map((id) => (
          <input key={id} type="hidden" name="clientId" value={id} />
        ))}

      {!creatingNewType ? (
        <div className="flex items-center gap-2">
          <select name="businessTypeId" required className={fieldClass("sm", "flex-1")}>
            <option value="">— בחירת סוג עסק —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreatingNewType(true)}
            className="whitespace-nowrap text-xs font-medium text-brand-purple hover:underline"
          >
            + סוג עסק חדש
          </button>
        </div>
      ) : (
        <input
          name="newTypeName"
          type="text"
          required
          placeholder="שם סוג העסק החדש"
          className={fieldClass("sm")}
        />
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={selectedIds.size === 0}>
          שיוך {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs font-medium text-text-muted hover:underline"
        >
          סגירה — השאר לא משויכים בינתיים
        </button>
      </div>
    </form>
  );
}
