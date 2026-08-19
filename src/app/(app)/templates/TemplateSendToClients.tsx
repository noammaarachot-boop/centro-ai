"use client";

import { useState } from "react";
import { Send, UserPlus } from "lucide-react";
import { Drawer } from "@/components/app/Drawer";
import { Button, buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { fieldClass } from "@/components/app/FormField";
import { sendTemplateRequest } from "./actions";

interface PickableClient {
  id: string;
  name: string;
  phone: string;
  hasActiveRequest: boolean;
}

// One combined action, replacing the old two-step "assign clients, then
// separately send" flow (assignClientsToTemplate + TemplateSendRequest) —
// a template isn't permanently tied to clients, so picking recipients and
// sending are one decision, not two, now opened from a drawer rather than
// an always-open page section. Every client with a non-terminal request
// from this exact template (hasActiveRequest, computed server-side via
// findClientIdsWithActiveRequest — the same predicate sendTemplateRequest's
// own duplicate guard uses) is shown, not hidden — marked and disabled, per
// the approved sketch, so it's obvious why they can't be picked rather than
// silently missing.
//
// Existing-client checkboxes and the new-client fields are both always
// present in the same <form> (never conditionally unmounted behind a tab)
// so one submit can genuinely combine "a few existing clients" + "one new
// one."
export function TemplateSendToClients({
  templateId,
  clients,
}: {
  templateId: string;
  clients: PickableClient[];
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
  const pickableCount = clients.filter((c) => !c.hasActiveRequest).length;

  return (
    <Drawer
      title="שליחה ללקוחות"
      triggerClassName={buttonVariants({ variant: "primary", size: "sm" })}
      trigger={
        <>
          <Send className="h-4 w-4" />
          שליחה ללקוחות
        </>
      }
    >
      <form action={boundSend} className="flex h-full flex-col gap-4">
        <p className="text-sm text-text-muted">
          בחרו לקוחות קיימים, ואפשר גם להוסיף לקוח חדש ולשלוח גם אליו — הכול בפעולה אחת.
        </p>

        {clients.length === 0 ? (
          <EmptyState icon={UserPlus} title="אין עדיין לקוחות במערכת" description="הוסיפו לקוח חדש למטה כדי לשלוח אליו." />
        ) : pickableCount === 0 ? (
          <p className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs text-text-secondary">
            לכל הלקוחות הקיימים כבר יש בקשה פעילה מהתבנית הזו — עדיין אפשר להוסיף לקוח חדש למטה.
          </p>
        ) : null}

        {clients.length > 0 && (
          <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-surface-muted/40 p-2">
            {clients.map((client) => (
              <li key={client.id}>
                <label
                  className={
                    client.hasActiveRequest
                      ? "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-text-muted opacity-60"
                      : "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-surface"
                  }
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="clientId"
                      value={client.id}
                      checked={selectedIds.has(client.id)}
                      disabled={client.hasActiveRequest}
                      onChange={() => toggleSelected(client.id)}
                      className="h-4 w-4 rounded border-border accent-brand-purple disabled:opacity-50"
                    />
                    {client.name}{" "}
                    <span dir="ltr" className="text-text-muted">
                      ({client.phone})
                    </span>
                  </span>
                  {client.hasActiveRequest && (
                    <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger">
                      כבר יש בקשה פעילה
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {showNewClient ? (
          <div className="space-y-2 rounded-xl border border-border bg-surface-muted/40 p-3">
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

        <div className="mt-auto space-y-3 border-t border-border pt-4">
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

          <Button type="submit" variant="primary" className="w-full" disabled={totalRecipients === 0}>
            <Send className="h-4 w-4" />
            {sendMode === "now" ? `שליחה ל-${totalRecipients} לקוחות` : "תזמון שליחה"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
