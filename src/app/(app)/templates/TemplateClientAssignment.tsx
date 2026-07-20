"use client";

import { useState } from "react";
import Link from "next/link";
import { UserPlus, X } from "lucide-react";
import { Card } from "@/components/app/Card";
import { Button, buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import {
  assignClientsToTemplate,
  createAndAssignClientToTemplate,
  removeClientFromTemplate,
} from "./actions";

interface AssignedClient {
  assignmentId: string;
  clientId: string;
  clientName: string;
}

interface UnassignedClient {
  id: string;
  name: string;
  phone: string;
}

// Mirrors Step5Analysis.tsx's unclassified-clients assign panel — a
// checkbox list + submit, with an inline "create new client" mode as a
// second tab rather than a separate page, since assigning a template to a
// client that doesn't exist yet is the common case for a one-time office.
export function TemplateClientAssignment({
  templateId,
  assignedClients,
  unassignedClients,
}: {
  templateId: string;
  assignedClients: AssignedClient[];
  unassignedClients: UnassignedClient[];
}) {
  const [showPanel, setShowPanel] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const boundAssign = assignClientsToTemplate.bind(null, templateId);
  const boundCreateAndAssign = createAndAssignClientToTemplate.bind(null, templateId);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold text-text-primary">לקוחות משויכים</h2>
      <p className="mb-4 text-sm text-text-muted">
        התבנית הזו תישלח לכל הלקוחות המשויכים כאן — אפשר לשייך לקוח אחד או כמה בבת אחת.
      </p>

      {assignedClients.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="אין עדיין לקוחות משויכים"
          description="שייכו לקוח קיים או צרו לקוח חדש כדי להתחיל."
        />
      ) : (
        <ul className="mb-4 space-y-2">
          {assignedClients.map((assignment) => (
            <li
              key={assignment.assignmentId}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted/40 px-4 py-2.5"
            >
              <Link
                href={`/clients/${assignment.clientId}`}
                className="text-sm font-medium text-text-primary transition-colors hover:text-brand-purple"
              >
                {assignment.clientName}
              </Link>
              <form action={removeClientFromTemplate.bind(null, templateId, assignment.assignmentId)}>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 text-xs font-medium text-danger transition-colors hover:underline"
                >
                  <X className="h-3 w-3" />
                  הסרה
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {!showPanel ? (
        <button
          type="button"
          onClick={() => setShowPanel(true)}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          שיוך לקוחות
        </button>
      ) : (
        <div className="animate-fade-in-up space-y-3 rounded-xl border border-border bg-surface p-3">
          <div className="flex gap-2 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={
                mode === "existing"
                  ? "rounded-full bg-brand-purple/10 px-3 py-1 text-brand-purple"
                  : "rounded-full px-3 py-1 text-text-muted hover:text-text-primary"
              }
            >
              לקוח קיים
            </button>
            <button
              type="button"
              onClick={() => setMode("new")}
              className={
                mode === "new"
                  ? "rounded-full bg-brand-purple/10 px-3 py-1 text-brand-purple"
                  : "rounded-full px-3 py-1 text-text-muted hover:text-text-primary"
              }
            >
              לקוח חדש
            </button>
          </div>

          {mode === "existing" ? (
            unassignedClients.length === 0 ? (
              <p className="text-xs text-text-muted">כל הלקוחות כבר משויכים לתבנית זו.</p>
            ) : (
              <form action={boundAssign} className="space-y-3">
                <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                  {unassignedClients.map((client) => (
                    <li key={client.id}>
                      <label className="flex items-center gap-2 text-xs text-text-primary">
                        <input
                          type="checkbox"
                          name="clientId"
                          value={client.id}
                          checked={selectedIds.has(client.id)}
                          onChange={() => toggleSelected(client.id)}
                          className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
                        />
                        {client.name}{" "}
                        <span dir="ltr" className="text-text-muted">
                          ({client.phone})
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <Button type="submit" variant="primary" size="sm" disabled={selectedIds.size === 0}>
                  שיוך {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
                </Button>
              </form>
            )
          ) : (
            <form action={boundCreateAndAssign} className="space-y-2">
              <input
                name="name"
                type="text"
                required
                placeholder="שם הלקוח"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
              <input
                name="phone"
                type="tel"
                dir="ltr"
                required
                placeholder="טלפון"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
              <input
                name="notes"
                type="text"
                placeholder="הערות (לא חובה)"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
              <Button type="submit" variant="primary" size="sm">
                יצירה ושיוך
              </Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
