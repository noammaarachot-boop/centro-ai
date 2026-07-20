"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Card } from "@/components/app/Card";
import { Button } from "@/components/app/Button";
import { sendTemplateRequest } from "./actions";

interface AssignedClient {
  assignmentId: string;
  clientId: string;
  clientName: string;
}

// Product Evolution M7 — every selected client gets their own collection
// request out of this one submit (see sendTemplateRequest). Defaults to
// every currently-assigned client selected, "Send Now" selected — the
// common case (send this template to everyone on it, right away) needs
// zero extra clicks.
export function TemplateSendRequest({
  templateId,
  assignedClients,
}: {
  templateId: string;
  assignedClients: AssignedClient[];
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(assignedClients.map((c) => c.clientId))
  );
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  // Sensible default for the datetime-local input: one hour from now.
  // Lazy useState initializer, not a plain render-time call — Date.now()
  // is impure and must only run once, on mount.
  const [defaultScheduleValue] = useState(() =>
    new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const boundSend = sendTemplateRequest.bind(null, templateId);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (assignedClients.length === 0) {
    return null;
  }

  return (
    <Card className="border-brand-purple/25 bg-brand-purple/5">
      <h2 className="mb-1 text-lg font-semibold text-text-primary">שליחת בקשה</h2>
      <p className="mb-4 text-sm text-text-muted">
        בחרו למי לשלוח את התבנית הזו, ומתי.
      </p>

      <form action={boundSend} className="space-y-4">
        <ul className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-white p-3">
          {assignedClients.map((client) => (
            <li key={client.assignmentId}>
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  name="clientId"
                  value={client.clientId}
                  checked={selectedIds.has(client.clientId)}
                  onChange={() => toggleSelected(client.clientId)}
                  className="h-4 w-4 rounded border-border accent-brand-purple"
                />
                {client.clientName}
              </label>
            </li>
          ))}
        </ul>

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
            className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
          />
        )}

        <Button type="submit" variant="primary" disabled={selectedIds.size === 0}>
          <Send className="h-4 w-4" />
          {sendMode === "now" ? `שליחה ל-${selectedIds.size} לקוחות` : "תזמון שליחה"}
        </Button>
      </form>
    </Card>
  );
}
