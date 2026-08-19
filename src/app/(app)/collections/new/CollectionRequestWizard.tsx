"use client";

import { useActionState, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  Loader2,
  Plus,
  Search,
  Send,
  Upload,
  UserPlus,
  X,
  AlertTriangle,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/app/Button";
import { fieldClass } from "@/components/app/FormField";
import { GoogleDriveConnectionRow, WhatsAppConnectionRow } from "@/app/onboarding/steps/Step3Connect";
import { TemplateRequirementRow } from "../../templates/TemplateRequirementRow";
import {
  addTemplateRequirement,
  createAndAssignClientToTemplate,
  createCollectionRequestDraft,
  deleteDraftCollectionRequest,
  importClientsForDraft,
  sendTemplateRequest,
  syncDraftClients,
  type CollectionRequestDraftState,
  type ImportClientsForDraftState,
} from "../../templates/actions";
import { WHATSAPP_NOT_READY_MESSAGE, DRIVE_NOT_READY_MESSAGE } from "@/lib/integrationMessages";

export type WizardStep = "what" | "who" | "when" | "connect" | "review" | "success";

interface RequirementRow {
  id: string;
  name: string;
}
interface AssignedClientRow {
  assignmentId: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
}
interface UnassignedClientRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

// Point 3 of the repeat-use rework — a small count shows real names, a
// large one shows a couple of names plus a count, instead of always just
// "X לקוחות". Shared between WhoStep's own selection summary and the
// Review step's recipient row so the two never phrase it differently.
function formatClientListLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} ועוד ${names.length - 2}`;
}

const STEP_ORDER: { key: WizardStep; label: string }[] = [
  { key: "what", label: "מה" },
  { key: "who", label: "למי" },
  { key: "when", label: "מתי" },
  { key: "connect", label: "חיבור" },
  { key: "review", label: "אישור" },
];

function ProgressDots({ step }: { step: WizardStep }) {
  if (step === "success") return null;
  const currentIndex = STEP_ORDER.findIndex((s) => s.key === step);
  return (
    <div className="mb-6 flex items-center justify-center gap-2" dir="rtl">
      {STEP_ORDER.map((s, index) => (
        <span
          key={s.key}
          className={
            "h-1.5 w-8 rounded-full transition-colors " +
            (index <= currentIndex ? "bg-gradient-to-l from-brand-purple to-brand-blue" : "bg-surface-muted")
          }
        />
      ))}
    </div>
  );
}

function SummarySidebar({
  definitionName,
  requirementCount,
  recipientLabel,
  whenLabel,
}: {
  definitionName?: string;
  requirementCount?: number;
  recipientLabel?: string;
  whenLabel?: string;
}) {
  return (
    <div className="w-full shrink-0 rounded-2xl border border-border bg-surface-muted/40 p-5 lg:w-64" dir="rtl">
      <p className="mb-3 text-xs font-bold tracking-wide text-text-muted uppercase">סיכום הבקשה</p>
      <ul className="space-y-3 text-sm">
        <li className="flex items-center justify-between gap-2 border-b border-border pb-3">
          <span className="text-text-muted">שם</span>
          <span className="font-medium text-text-primary">{definitionName ?? "—"}</span>
        </li>
        <li className="flex items-center justify-between gap-2 border-b border-border pb-3">
          <span className="text-text-muted">מסמכים</span>
          <span className="font-medium text-text-primary">
            {requirementCount !== undefined ? `${requirementCount} נבחרו` : "—"}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2 border-b border-border pb-3 last:border-0 last:pb-0">
          <span className="text-text-muted">נמענים</span>
          <span className="font-medium text-text-primary">{recipientLabel ?? "טרם נבחר"}</span>
        </li>
        {whenLabel && (
          <li className="flex items-center justify-between gap-2">
            <span className="text-text-muted">מתי</span>
            <span className="font-medium text-text-primary">{whenLabel}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

// Repeat-use polish — the wizard's Cancel action. Modeled on
// ConfirmDialog's own native-Popover-API pattern (same shell, same icon
// treatment, same Button components), just with three outcomes instead of
// two: ConfirmDialog itself is a strict confirm/cancel shape and doesn't
// fit a "save as draft, or delete, or go back" choice. "שמירה כטיוטה" does
// nothing beyond navigating away — every step already persists to the DB
// as it's completed (this wizard has no unsaved client-only state), so the
// in-progress services row is already a real Draft the moment you leave;
// resolveOnDemandDraft (now called unconditionally from /collections/new,
// see page.tsx) is what resumes it next time.
function CancelDraftDialog({ draftId }: { draftId: string }) {
  const popoverId = useId();
  const boundDelete = deleteDraftCollectionRequest.bind(null, draftId);

  return (
    <>
      <button
        type="button"
        popoverTarget={popoverId}
        popoverTargetAction="show"
        className="text-sm font-medium text-text-muted transition-colors hover:text-danger"
      >
        ביטול
      </button>
      <div
        popover="auto"
        id={popoverId}
        className="centro-glass-strong m-auto w-full max-w-sm rounded-2xl border border-border p-6 shadow-card-lg backdrop:bg-text-primary/40 backdrop:backdrop-blur-sm"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="centro-icon-danger grid h-10 w-10 shrink-0 place-items-center rounded-xl">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">לבטל את הבקשה?</h2>
            <p className="mt-1 text-sm text-text-secondary">
              אפשר לשמור את מה שהתחלתם כטיוטה ולחזור אליה מאוחר יותר, או למחוק את הבקשה לגמרי.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Link href="/collections" className={buttonVariants({ variant: "secondary", size: "sm", className: "w-full" })}>
            שמירה כטיוטה
          </Link>
          <form action={boundDelete}>
            <Button type="submit" variant="danger" size="sm" className="w-full">
              מחיקת הבקשה
            </Button>
          </form>
          <button
            type="button"
            popoverTarget={popoverId}
            popoverTargetAction="hide"
            className="w-full rounded-full px-4 py-2 text-center text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            חזרה לעריכה
          </button>
        </div>
      </div>
    </>
  );
}

// Step "What will be sent?" — only ever rendered before a draft exists.
// First request keeps the exact original design: suggestions arrive
// pre-checked and a name is required. From the second request on
// (isFirstRequest === false, computed server-side in page.tsx from
// hasSentAnyOnDemandRequest — never a client-side guess), nothing is
// auto-selected: suggestions are click-to-add chips, the name is optional
// (createCollectionRequestDraft auto-fills a safe default when left
// blank), and every added document — suggested or typed — shows in one
// list with its own remove (X), never a checkmark implying "done".
function WhatStep({
  isFirstRequest,
  suggestedRequirementNames,
}: {
  isFirstRequest: boolean;
  suggestedRequirementNames: string[];
}) {
  const initialState: CollectionRequestDraftState = {};
  const [state, formAction, isPending] = useActionState(createCollectionRequestDraft, initialState);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(isFirstRequest ? suggestedRequirementNames : []));
  const [customDocs, setCustomDocs] = useState<string[]>([]);
  const [addedDocs, setAddedDocs] = useState<string[]>([]);
  const [newDoc, setNewDoc] = useState("");

  function toggleChecked(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function addDoc(name: string) {
    const trimmed = name.trim();
    if (!trimmed || addedDocs.includes(trimmed)) return;
    setAddedDocs((prev) => [...prev, trimmed]);
  }

  function removeAddedDoc(name: string) {
    setAddedDocs((prev) => prev.filter((d) => d !== name));
  }

  function addCustomDoc() {
    const trimmed = newDoc.trim();
    if (!trimmed) return;
    if (isFirstRequest) {
      setCustomDocs((prev) => [...prev, trimmed]);
      setChecked((prev) => new Set(prev).add(trimmed));
    } else {
      addDoc(trimmed);
    }
    setNewDoc("");
  }

  const firstRequestDocNames = [...suggestedRequirementNames, ...customDocs];
  const availableSuggestions = suggestedRequirementNames.filter((n) => !addedDocs.includes(n));
  const canSubmit = isFirstRequest ? checked.size > 0 : addedDocs.length > 0;

  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-purple" />
        <p className="text-sm text-text-secondary">יוצר את בקשת האיסוף...</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-5" dir="rtl">
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-text-secondary">
          שם הבקשה {!isFirstRequest && <span className="font-normal text-text-muted">(לא חובה)</span>}
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required={isFirstRequest}
          defaultValue={isFirstRequest ? "מסמכים לפתיחת תיק" : undefined}
          placeholder={isFirstRequest ? undefined : "לדוגמה: מסמכים לחידוש חוזה"}
          className={fieldClass("md")}
        />
        {state.fieldErrors?.name && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      {isFirstRequest ? (
        firstRequestDocNames.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border bg-brand-purple/5 px-4 py-2.5 text-xs font-bold text-brand-purple">
              מסמכים מוצעים
            </div>
            <ul className="divide-y divide-border">
              {firstRequestDocNames.map((docName) => (
                <li key={docName} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <label className="flex flex-1 items-center gap-2.5 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      name="requirementName"
                      value={docName}
                      checked={checked.has(docName)}
                      onChange={() => toggleChecked(docName)}
                      className="h-4 w-4 rounded border-border accent-brand-purple"
                    />
                    {docName}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <>
          {availableSuggestions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold tracking-wide text-text-muted uppercase">
                מסמכים מוצעים — לחצו כדי להוסיף
              </p>
              <div className="flex flex-wrap gap-2">
                {availableSuggestions.map((docName) => (
                  <button
                    key={docName}
                    type="button"
                    onClick={() => addDoc(docName)}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted/40 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-brand-purple/40 hover:bg-brand-purple/5 hover:text-brand-purple"
                  >
                    <Plus className="h-3 w-3" />
                    {docName}
                  </button>
                ))}
              </div>
            </div>
          )}

          {addedDocs.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border bg-brand-purple/5 px-4 py-2.5 text-xs font-bold text-brand-purple">
                המסמכים לבקשה
              </div>
              <ul className="divide-y divide-border">
                {addedDocs.map((docName) => (
                  <li key={docName} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-sm text-text-primary">{docName}</span>
                    <button
                      type="button"
                      onClick={() => removeAddedDoc(docName)}
                      aria-label={`הסרת ${docName}`}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <input type="hidden" name="requirementName" value={docName} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newDoc}
          onChange={(e) => setNewDoc(e.currentTarget.value)}
          placeholder="הוספת מסמך"
          className={fieldClass("md", "flex-1")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustomDoc();
            }
          }}
        />
        <button
          type="button"
          onClick={addCustomDoc}
          className={buttonVariants({ variant: "secondary", size: "md" })}
        >
          <Plus className="h-4 w-4" />
          הוספת מסמך
        </button>
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!canSubmit}>
        המשך
      </Button>
    </form>
  );
}

interface SelectableClient {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

// Step "Who should receive it?" — first-run (zero clients anywhere in the
// org) still gets the single-client inline bootstrap form, unchanged.
// Otherwise: one unified, always-editable checkbox list — every org client
// shown, already-assigned ones pre-checked (not "all clients" auto-picked;
// see point 2 of the repeat-use rework), with search and an explicit,
// secondary "select all" action rather than that being the default.
function WhoStep({
  draftId,
  totalOrgClients,
  assignedClients,
  unassignedClients,
}: {
  draftId: string;
  totalOrgClients: number;
  assignedClients: AssignedClientRow[];
  unassignedClients: UnassignedClientRow[];
}) {
  const boundCreateAndAssign = createAndAssignClientToTemplate.bind(null, draftId);
  const boundSync = syncDraftClients.bind(null, draftId);
  const importInitialState: ImportClientsForDraftState = {};
  const [importState, importAction, importPending] = useActionState(
    importClientsForDraft.bind(null, draftId),
    importInitialState
  );

  const allClients = useMemo<SelectableClient[]>(() => {
    const assigned = assignedClients.map((c) => ({
      id: c.clientId,
      name: c.clientName,
      phone: c.clientPhone,
      email: c.clientEmail,
    }));
    return [...assigned, ...unassignedClients];
  }, [assignedClients, unassignedClients]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(assignedClients.map((c) => c.clientId))
  );
  const [search, setSearch] = useState("");
  const [showNewClient, setShowNewClient] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // A client added mid-step (inline "לקוח חדש" or "ייבוא לקוחות", both of
  // which persist immediately and refresh() the page's server data) must
  // show up checked once the refreshed assignedClients prop arrives. This
  // is React's own documented "adjusting state when a prop changes"
  // pattern — setState called during render, gated on a previous-value
  // comparison held in state (never a ref: this project's stricter
  // react-hooks/refs lint rule disallows reading/writing ref.current
  // during render, see ConfirmDialog's own comment for why) — so it's one
  // extra render pass, immediately, before paint, never a useEffect
  // cascade. Only ever adds ids, never removes one the user already
  // unchecked.
  const assignedIdsKey = assignedClients.map((c) => c.clientId).join(",");
  const [lastAssignedIdsKey, setLastAssignedIdsKey] = useState(assignedIdsKey);
  if (assignedIdsKey !== lastAssignedIdsKey) {
    setLastAssignedIdsKey(assignedIdsKey);
    setSelectedIds((prev) => new Set([...prev, ...assignedClients.map((c) => c.clientId)]));
  }

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filteredClients = normalizedSearch
    ? allClients.filter(
        (c) =>
          c.name.toLowerCase().includes(normalizedSearch) ||
          c.phone.includes(normalizedSearch) ||
          (c.email ?? "").toLowerCase().includes(normalizedSearch)
      )
    : allClients;

  function selectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredClients.forEach((c) => next.add(c.id));
      return next;
    });
  }

  if (totalOrgClients === 0 && allClients.length === 0) {
    return (
      <form action={boundCreateAndAssign} className="space-y-4" dir="rtl">
        <p className="text-sm text-text-secondary">עדיין אין לקוחות — נתחיל עם לקוח אחד כדי לנסות.</p>
        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-text-secondary">
            שם הלקוח
          </label>
          <input id="name" name="name" type="text" required placeholder="ישראל ישראלי" className={fieldClass("md")} />
        </div>
        <div>
          <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-text-secondary">
            טלפון (WhatsApp)
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            dir="ltr"
            required
            placeholder="05X-XXXXXXX"
            className={fieldClass("md")}
          />
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full">
          המשך
        </Button>
      </form>
    );
  }

  const selectedNames = allClients.filter((c) => selectedIds.has(c.id)).map((c) => c.name);

  return (
    <div className="space-y-4" dir="rtl">
      <div className="relative">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="חיפוש לפי שם או טלפון..."
          className={fieldClass("md", "ps-9")}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {selectedIds.size > 0 ? formatClientListLabel(selectedNames) : "לא נבחרו לקוחות"}
        </p>
        <button type="button" onClick={selectAllVisible} className="shrink-0 text-xs font-medium text-brand-purple hover:underline">
          בחירת הכל{normalizedSearch ? " (מהתוצאות)" : ""}
        </button>
      </div>

      <form action={boundSync} className="space-y-3">
        {filteredClients.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface-muted/40 px-4 py-6 text-center text-sm text-text-muted">
            לא נמצאו לקוחות תואמים לחיפוש.
          </p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {filteredClients.map((client) => (
              <li key={client.id}>
                <label className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-muted">
                  <input
                    type="checkbox"
                    name="clientId"
                    value={client.id}
                    checked={selectedIds.has(client.id)}
                    onChange={() => toggle(client.id)}
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

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={selectedIds.size === 0}>
          המשך
        </Button>
      </form>

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowNewClient((v) => !v)}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <UserPlus className="h-3.5 w-3.5" />
          לקוח חדש
        </button>
        <button
          type="button"
          onClick={() => setShowImport((v) => !v)}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Upload className="h-3.5 w-3.5" />
          ייבוא לקוחות
        </button>
      </div>

      {showNewClient && (
        <form action={boundCreateAndAssign} className="space-y-2 rounded-xl border border-border bg-surface-muted/40 p-3">
          <p className="text-xs font-semibold text-text-secondary">לקוח חדש</p>
          <input name="name" type="text" required placeholder="שם הלקוח" className={fieldClass("sm")} />
          <input name="phone" type="tel" dir="ltr" required placeholder="טלפון (WhatsApp)" className={fieldClass("sm")} />
          <button type="submit" className={buttonVariants({ variant: "primary", size: "sm", className: "w-full" })}>
            הוספה ושיוך לבקשה
          </button>
        </form>
      )}

      {showImport && (
        <form action={importAction} className="space-y-2 rounded-xl border border-border bg-surface-muted/40 p-3">
          <label
            htmlFor="import-file"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border bg-surface px-4 py-6 text-center transition-colors hover:border-brand-purple/40"
          >
            <FileSpreadsheet className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <span className="text-xs font-medium text-text-primary">לחצו לבחירת קובץ Excel / CSV</span>
            <span className="text-[11px] text-text-muted">רק שם וטלפון יישמרו, ויצורפו כנמענים לבקשה.</span>
            <input id="import-file" name="file" type="file" accept=".csv,.xlsx,.xls" required className="hidden" />
          </label>
          {importState.error && (
            <p role="alert" className="text-xs font-medium text-danger">
              {importState.error}
            </p>
          )}
          {importState.imported !== undefined && (
            <p className="text-xs font-medium text-brand-emerald">
              {importState.imported} לקוחות יובאו ושויכו לבקשה
              {importState.skipped ? ` (${importState.skipped} שורות דולגו)` : ""}.
            </p>
          )}
          <button
            type="submit"
            disabled={importPending}
            className={buttonVariants({ variant: "primary", size: "sm", className: "w-full" })}
          >
            <Upload className="h-3.5 w-3.5" />
            {importPending ? "מייבא..." : "ייבוא"}
          </button>
        </form>
      )}
    </div>
  );
}

function WhenStep({
  draftId,
  initialSendMode,
  initialScheduledFor,
}: {
  draftId: string;
  initialSendMode?: string;
  initialScheduledFor?: string;
}) {
  const [sendMode, setSendMode] = useState<"now" | "schedule">(initialSendMode === "schedule" ? "schedule" : "now");
  const [defaultScheduleValue] = useState(
    () => initialScheduledFor || new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16)
  );

  return (
    <form method="get" action="/collections/new" className="space-y-3" dir="rtl">
      <input type="hidden" name="draft" value={draftId} />
      <input type="hidden" name="step" value="connect" />

      <label
        className={
          "flex items-start gap-3 rounded-xl border p-4 transition-colors " +
          (sendMode === "now" ? "border-brand-purple bg-brand-purple/5" : "border-border")
        }
      >
        <input
          type="radio"
          name="sendMode"
          value="now"
          checked={sendMode === "now"}
          onChange={() => setSendMode("now")}
          className="mt-0.5 h-4 w-4 accent-brand-purple"
        />
        <span>
          <span className="block text-sm font-semibold text-text-primary">עכשיו</span>
          <span className="block text-xs text-text-muted">רוב העסקים שולחים מיד לאחר יצירת הבקשה</span>
        </span>
      </label>

      <label
        className={
          "flex items-start gap-3 rounded-xl border p-4 transition-colors " +
          (sendMode === "schedule" ? "border-brand-purple bg-brand-purple/5" : "border-border")
        }
      >
        <input
          type="radio"
          name="sendMode"
          value="schedule"
          checked={sendMode === "schedule"}
          onChange={() => setSendMode("schedule")}
          className="mt-0.5 h-4 w-4 accent-brand-purple"
        />
        <span>
          <span className="block text-sm font-semibold text-text-primary">בתאריך אחר</span>
          <span className="block text-xs text-text-muted">אפשר גם לתזמן לשליחה מאוחר יותר</span>
        </span>
      </label>

      {sendMode === "schedule" && (
        <input
          type="datetime-local"
          name="scheduledFor"
          dir="ltr"
          defaultValue={defaultScheduleValue}
          className={fieldClass("md")}
        />
      )}

      <Button type="submit" variant="primary" size="lg" className="w-full">
        המשך
      </Button>
    </form>
  );
}

function ConnectStep({
  draftId,
  sendMode,
  scheduledFor,
  integrationReady,
  googleConnectedAt,
  googleDriveFolderId,
  googleDriveFolderName,
  whatsappConnectedAt,
  whatsappDisplayPhoneNumber,
}: {
  draftId: string;
  sendMode: string;
  scheduledFor: string;
  integrationReady: boolean;
  googleConnectedAt: Date | null;
  googleDriveFolderId: string | null;
  googleDriveFolderName: string | null;
  whatsappConnectedAt: Date | null;
  whatsappDisplayPhoneNumber: string | null;
}) {
  const continueHref = `/collections/new?draft=${draftId}&step=review&sendMode=${sendMode}${
    scheduledFor ? `&scheduledFor=${encodeURIComponent(scheduledFor)}` : ""
  }`;

  return (
    <div className="space-y-4" dir="rtl">
      <GoogleDriveConnectionRow
        googleConnectedAt={googleConnectedAt}
        googleDriveFolderId={googleDriveFolderId}
        googleDriveFolderName={googleDriveFolderName}
        connectReturnTo="/collections/new?step=connect"
      />
      <WhatsAppConnectionRow
        whatsappConnectedAt={whatsappConnectedAt}
        whatsappDisplayPhoneNumber={whatsappDisplayPhoneNumber}
      />

      {!integrationReady && (
        <p className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs leading-relaxed text-text-secondary">
          כדי לשלוח בקשות וגם לשמור בבטחה כל מסמך שיתקבל, צריך לחבר את שני השירותים האלה — אי אפשר
          לשלוח בקשה לפני ששניהם מחוברים, כדי שמסמך שלקוח שולח מיד לא יאבד אף פעם.
        </p>
      )}

      {integrationReady ? (
        <Link href={continueHref} className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}>
          המשך
        </Link>
      ) : (
        <button
          type="button"
          disabled
          title="יש לחבר את שני השירותים כדי להמשיך"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </button>
      )}
    </div>
  );
}

const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  "no-clients-selected": "יש לבחור לפחות לקוח אחד לשליחה.",
  "invalid-schedule": "יש לבחור מועד עתידי לתזמון השליחה.",
  "whatsapp-not-ready": WHATSAPP_NOT_READY_MESSAGE,
  "drive-not-ready": DRIVE_NOT_READY_MESSAGE,
};

// Point 6 of the repeat-use rework — every summary row here is either a
// real inline editor (documents: reuses TemplateRequirementRow, the exact
// same row the template management page already uses, plus
// addTemplateRequirement for adding one more) or a link back to the real
// editing step for that field (clients -> who, when -> when), so a mistake
// noticed at review never means starting the whole request over.
function ReviewStep({
  draftId,
  definitionName,
  requirements,
  assignedClients,
  sendMode,
  scheduledFor,
  error,
}: {
  draftId: string;
  definitionName: string;
  requirements: RequirementRow[];
  assignedClients: AssignedClientRow[];
  sendMode: string;
  scheduledFor: string;
  error?: string;
}) {
  const boundSend = sendTemplateRequest.bind(null, draftId);
  const boundAddRequirement = addTemplateRequirement.bind(null, draftId);
  const [docsExpanded, setDocsExpanded] = useState(false);
  const [clientsExpanded, setClientsExpanded] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  // Point 5 of the repeat-use rework — "double click cannot produce a
  // duplicate send". sendTemplateRequest itself isn't wrapped in
  // useActionState (it always redirects, never returns state to render),
  // so there's no built-in `pending` here — disabling synchronously in
  // onSubmit (same idiom as the "add document" mini-form's onSubmit
  // below) is what stops a second click on the real button from ever
  // reaching the server, covering the overwhelming majority of real
  // double-clicks. It intentionally never resets to false: a successful
  // submit navigates away (to Success or, on a validation error, back to
  // this same Review step with a fresh server-rendered component), so
  // there's nothing to "re-enable" for.
  const [isSubmitting, setIsSubmitting] = useState(false);

  const clientNames = assignedClients.map((c) => c.clientName);
  const recipientLabel = formatClientListLabel(clientNames);
  const whenLabel = sendMode === "schedule" ? "מתוזמן" : "עכשיו";

  return (
    <form action={boundSend} dir="rtl" onSubmit={() => setIsSubmitting(true)}>
      <input type="hidden" name="sendMode" value={sendMode} />
      {sendMode === "schedule" && <input type="hidden" name="scheduledFor" value={scheduledFor} />}
      <input type="hidden" name="redirectTo" value={`/collections/new?draft=${draftId}&step=success`} />
      {assignedClients.map((c) => (
        <input key={c.clientId} type="hidden" name="clientId" value={c.clientId} />
      ))}

      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="border-b border-border bg-surface-muted/40 px-6 py-4 text-center">
          <p className="text-[11px] font-bold tracking-wide text-text-muted uppercase">בקשת האיסוף</p>
          <p className="text-base font-bold text-text-primary">{definitionName}</p>
        </div>
        <div className="space-y-0 px-6">
          <div className="border-b border-border py-3">
            <button
              type="button"
              onClick={() => setDocsExpanded((v) => !v)}
              className="flex w-full items-center justify-between gap-3 text-start"
            >
              <span className="flex items-center gap-2 text-xs text-text-muted">
                <FileText className="h-3.5 w-3.5" />
                מה נשלח
              </span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                {requirements.length} מסמכים
                {docsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </button>
            {docsExpanded && (
              <div className="mt-3 space-y-2">
                {requirements.length > 0 && (
                  <ul className="space-y-1.5">
                    {requirements.map((req, index) => (
                      <TemplateRequirementRow
                        key={req.id}
                        templateId={draftId}
                        requirementId={req.id}
                        name={req.name}
                        isFirst={index === 0}
                        isLast={index === requirements.length - 1}
                      />
                    ))}
                  </ul>
                )}
                <form
                  action={boundAddRequirement}
                  className="flex items-center gap-2"
                  onSubmit={() => setNewDocName("")}
                >
                  <input
                    name="name"
                    type="text"
                    value={newDocName}
                    onChange={(e) => setNewDocName(e.currentTarget.value)}
                    placeholder="הוספת מסמך"
                    className={fieldClass("sm", "flex-1")}
                  />
                  <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    <Plus className="h-3.5 w-3.5" />
                    הוספה
                  </button>
                </form>
              </div>
            )}
          </div>

          <div className="border-b border-border py-3">
            <button
              type="button"
              onClick={() => setClientsExpanded((v) => !v)}
              className="flex w-full items-center justify-between gap-3 text-start"
            >
              <span className="flex items-center gap-2 text-xs text-text-muted">
                <UserPlus className="h-3.5 w-3.5" />
                למי
              </span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                {recipientLabel || "—"}
                {clientsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </button>
            {clientsExpanded && (
              <div className="mt-3 space-y-2">
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface-muted/40 p-2 text-sm text-text-primary">
                  {assignedClients.map((c) => (
                    <li key={c.clientId} className="px-2 py-1">
                      {c.clientName}{" "}
                      <span dir="ltr" className="text-text-muted">
                        ({c.clientPhone})
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/collections/new?draft=${draftId}&step=who`}
                  className="inline-block text-xs font-medium text-brand-purple hover:underline"
                >
                  עריכת הבחירה
                </Link>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 py-3">
            <span className="text-xs text-text-muted">מתי</span>
            <Link
              href={`/collections/new?draft=${draftId}&step=when`}
              className="text-sm font-semibold text-text-primary underline decoration-dotted underline-offset-4 hover:text-brand-purple"
            >
              {whenLabel}
            </Link>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 bg-brand-emerald/5 px-6 py-3 text-sm font-semibold text-brand-emerald">
          <span>חיבורים</span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            WhatsApp + Drive מחוברים
          </span>
        </div>
        <div className="space-y-3 px-6 py-5">
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {REVIEW_ERROR_MESSAGES[error] ?? "אירעה שגיאה. נסו שוב."}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting} disabled={isSubmitting}>
            <Send className="h-4 w-4" />
            {isSubmitting ? "שולח…" : "אישור ושליחה"}
          </Button>
          <div className="text-center">
            <CancelDraftDialog draftId={draftId} />
          </div>
        </div>
      </div>
    </form>
  );
}

function SuccessStep({
  definitionId,
  recipientLabel,
  isSingular,
}: {
  definitionId: string;
  recipientLabel: string;
  isSingular: boolean;
}) {
  return (
    <div className="space-y-5 text-center" dir="rtl">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-emerald/10">
        <CheckCircle2 className="h-8 w-8 text-brand-emerald" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-text-primary">
          {isSingular ? `הבקשה נשלחה בהצלחה ל${recipientLabel}` : `הבקשה נשלחה בהצלחה ל-${recipientLabel}`}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          Centro ימשיך לנהל תזכורות ואיסוף מסמכים באופן אוטומטי — אין צורך לעשות דבר נוסף.
        </p>
      </div>
      <Link href="/dashboard" className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}>
        מעבר ללוח הבקרה
      </Link>
      <div className="space-y-1 border-t border-border pt-4">
        <Link
          href={`/collections/manage/${definitionId}`}
          className="flex items-center justify-between px-1 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-brand-purple"
        >
          צפייה בבקשה
        </Link>
        <Link
          href="/collections/new"
          className="flex items-center justify-between px-1 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-brand-purple"
        >
          יצירת בקשה נוספת
        </Link>
      </div>
    </div>
  );
}

export function CollectionRequestWizard(props: {
  step: WizardStep;
  draftId?: string;
  isFirstRequest?: boolean;
  definitionName?: string;
  requirements?: RequirementRow[];
  assignedClients?: AssignedClientRow[];
  unassignedClients?: UnassignedClientRow[];
  suggestedRequirementNames?: string[];
  totalOrgClients?: number;
  integrationReady?: boolean;
  googleConnectedAt?: Date | null;
  googleDriveFolderId?: string | null;
  googleDriveFolderName?: string | null;
  whatsappConnectedAt?: Date | null;
  whatsappDisplayPhoneNumber?: string | null;
  sendMode?: string;
  scheduledFor?: string;
  sentCount?: number;
  scheduledCount?: number;
  error?: string;
}) {
  const { step } = props;

  if (step === "success") {
    const total = (props.sentCount ?? 0) + (props.scheduledCount ?? 0);
    const assignedClients = props.assignedClients ?? [];
    const recipientLabel =
      assignedClients.length === 1 ? assignedClients[0].clientName : `${total || assignedClients.length} לקוחות`;
    return (
      <main className="centro-app-ambient flex min-h-screen justify-center px-4 py-16">
        <div className="w-full max-w-sm">
          <div className="centro-glass-strong animate-fade-in-up rounded-2xl border border-border p-8 shadow-card-lg">
            <SuccessStep
              definitionId={props.draftId ?? ""}
              recipientLabel={recipientLabel}
              isSingular={assignedClients.length === 1}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="centro-app-ambient min-h-screen px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-3xl">
        <ProgressDots step={step} />
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="centro-glass-strong animate-fade-in-up flex-1 rounded-2xl border border-border p-6 shadow-card-lg sm:p-8">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h1 className="text-xl font-bold text-text-primary">
                {step === "what" && "מה תרצו לבקש?"}
                {step === "who" && "למי לשלוח?"}
                {step === "when" && "מתי לשלוח את הבקשה?"}
                {step === "connect" && "נשארו שני חיבורים כדי לשלוח"}
                {step === "review" && "מוכנים לשלוח?"}
              </h1>
              {props.draftId && step !== "review" && <CancelDraftDialog draftId={props.draftId} />}
            </div>

            {step === "what" && (
              <WhatStep
                isFirstRequest={props.isFirstRequest ?? true}
                suggestedRequirementNames={props.suggestedRequirementNames ?? []}
              />
            )}

            {step === "who" && props.draftId && (
              <WhoStep
                draftId={props.draftId}
                totalOrgClients={props.totalOrgClients ?? 0}
                assignedClients={props.assignedClients ?? []}
                unassignedClients={props.unassignedClients ?? []}
              />
            )}

            {step === "when" && props.draftId && (
              <WhenStep
                draftId={props.draftId}
                initialSendMode={props.sendMode}
                initialScheduledFor={props.scheduledFor}
              />
            )}

            {step === "connect" && props.draftId && (
              <ConnectStep
                draftId={props.draftId}
                sendMode={props.sendMode ?? "now"}
                scheduledFor={props.scheduledFor ?? ""}
                integrationReady={!!props.integrationReady}
                googleConnectedAt={props.googleConnectedAt ?? null}
                googleDriveFolderId={props.googleDriveFolderId ?? null}
                googleDriveFolderName={props.googleDriveFolderName ?? null}
                whatsappConnectedAt={props.whatsappConnectedAt ?? null}
                whatsappDisplayPhoneNumber={props.whatsappDisplayPhoneNumber ?? null}
              />
            )}

            {step === "review" && props.draftId && (
              <ReviewStep
                draftId={props.draftId}
                definitionName={props.definitionName ?? ""}
                requirements={props.requirements ?? []}
                assignedClients={props.assignedClients ?? []}
                sendMode={props.sendMode ?? "now"}
                scheduledFor={props.scheduledFor ?? ""}
                error={props.error}
              />
            )}
          </div>

          {step !== "what" && (
            <SummarySidebar
              definitionName={props.definitionName}
              requirementCount={props.requirements?.length}
              recipientLabel={
                (props.assignedClients?.length ?? 0) > 0
                  ? formatClientListLabel(props.assignedClients!.map((c) => c.clientName))
                  : undefined
              }
              whenLabel={step === "connect" || step === "review" ? (props.sendMode === "schedule" ? "מתוזמן" : "עכשיו") : undefined}
            />
          )}
        </div>
      </div>
    </main>
  );
}
