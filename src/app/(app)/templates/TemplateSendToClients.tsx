"use client";

import { useState } from "react";
import { Send, UserPlus } from "lucide-react";
import { Card } from "@/components/app/Card";
import { Button, buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { fieldClass } from "@/components/app/FormField";
import { sendTemplateRequest } from "./actions";

interface CandidateClient {
  id: string;
  name: string;
  phone: string;
}

// One combined action, replacing the old two-step "assign clients, then
// separately send" flow (assignClientsToTemplate + TemplateSendRequest) —
// a template isn't permanently tied to clients, so picking recipients and
// sending are one decision, not two. Candidates already exclude every
// client with a non-terminal request from this exact template (computed
// server-side via findClientIdsWithActiveRequest) — the duplicate guard in
// sendTemplateRequest itself is the real enforcement; this list is just
// the honest reflection of it, so there's nothing confusing to pick that
// would be silently skipped anyway.
//
// Existing-client checkboxes and the new-client fields are both always
// present in the same <form> (never conditionally unmounted behind a tab)
// so one submit can genuinely combine "a few existing clients" + "one new
// one" — exactly what the product ask described, not an either/or.
export function TemplateSendToClients({
  templateId,
  candidateClients,
}: {
  templateId: string;
  candidateClients: CandidateClient[];
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [defaultScheduleValue] = useState(() => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16));

  const boundSend = sendTemplateRequest.bind(null, templateId);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasNewClient = showNewClient && newClientName.trim() !== "" && newClientPhone.trim() !== "";
  const totalRecipients = selectedIds.size + (hasNewClient ? 1 : 0);

  return (
    <Card className="border-brand-purple/25 bg-brand-purple/5">
      <h2 className="mb-1 text-lg font-semibold text-text-primary">שליחה ללקוחות</h2>
      <p className="mb-4 text-sm text-text-muted">
        בחרו לקוחות קיימים, ואפשר גם להוסיף לקוח חדש ולשלוח גם אליו — הכול בפעולה אחת.
      </p>

      <form action={boundSend} className="space-y-4">
        {candidateClients.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="אין כרגע לקוחות קיימים זמינים"
            description="לכל הלקוחות הקיימים כבר יש בקשה פעילה מהתבנית הזו — עדיין אפשר להוסיף לקוח חדש למטה."
          />
        ) : (
          <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-white p-3">
            {candidateClients.map((client) => (
              <li key={client.id}>
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    name="clientId"
                    value={client.id}
                    checked={selectedIds.has(client.id)}
                    onChange={() => toggleSelected(client.id)}
                    className="h-4 w-4 rounded border-border accent-brand-purple"
                  />
                  {client.name}{" "}
                  <span dir="ltr" className="text-text-muted">
                    ({client.phone})
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {showNewClient ? (
          <div className="space-y-2 rounded-xl border border-border bg-white p-3">
            <p className="text-xs font-semibold text-text-secondary">לקוח חדש</p>
            <input
              name="newClientName"
              type="text"
              placeholder="שם הלקוח"
              value={newClientName}
              onChange={(e) => setNewClientName(e.currentTarget.value)}
              className={fieldClass("sm")}
            />
            <input
              name="newClientPhone"
              type="tel"
              dir="ltr"
              placeholder="טלפון (WhatsApp)"
              value={newClientPhone}
              onChange={(e) => setNewClientPhone(e.currentTarget.value)}
              className={fieldClass("sm")}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNewClient(true)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <UserPlus className="h-3.5 w-3.5" />
            הוספת לקוח חדש
          </button>
        )}

        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="sendMode"
              value="now"
              checked={sendMode === "now"}
              onChange={() => setSendMode("now")}
              className="h-4 w-4 accent-brand-purple"
            />
            שליחה עכשיו
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="sendMode"
              value="schedule"
              checked={sendMode === "schedule"}
              onChange={() => setSendMode("schedule")}
              className="h-4 w-4 accent-brand-purple"
            />
            תזמון למועד עתידי
          </label>
        </div>

        {sendMode === "schedule" && (
          <input
            type="datetime-local"
            name="scheduledFor"
            dir="ltr"
            defaultValue={defaultScheduleValue}
            className={fieldClass("md")}
          />
        )}

        <Button type="submit" variant="primary" disabled={totalRecipients === 0}>
          <Send className="h-4 w-4" />
          {sendMode === "now" ? `שליחה ל-${totalRecipients} לקוחות` : "תזמון שליחה"}
        </Button>
      </form>
    </Card>
  );
}
