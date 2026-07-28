"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { CheckCircle2, FileText, Loader2, Plus, Send, UserPlus } from "lucide-react";
import { Button, buttonVariants } from "@/components/app/Button";
import { fieldClass } from "@/components/app/FormField";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { GoogleDriveConnectionRow, WhatsAppConnectionRow } from "@/app/onboarding/steps/Step3Connect";
import {
  assignClientsToTemplate,
  createAndAssignClientToTemplate,
  createCollectionRequestDraft,
  sendTemplateRequest,
  type CollectionRequestDraftState,
} from "../../templates/actions";

export type WizardStep = "what" | "who" | "when" | "connect" | "review" | "success";

interface RequirementRow {
  id: string;
  name: string;
}
interface AssignedClientRow {
  assignmentId: string;
  clientId: string;
  clientName: string;
}
interface UnassignedClientRow {
  id: string;
  name: string;
  phone: string;
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

// Step "What will be sent?" — only ever rendered before a draft exists.
// Name + suggested documents (pre-checked, editable) in one submit, per the
// locked design; see createCollectionRequestDraft's own comment for why
// this needed a new combined action rather than reusing createTemplate +
// addTemplateRequirement one call at a time.
function WhatStep({ suggestedRequirementNames }: { suggestedRequirementNames: string[] }) {
  const initialState: CollectionRequestDraftState = {};
  const [state, formAction, isPending] = useActionState(createCollectionRequestDraft, initialState);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(suggestedRequirementNames));
  const [customDocs, setCustomDocs] = useState<string[]>([]);
  const [newDoc, setNewDoc] = useState("");

  function toggle(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function addCustomDoc() {
    const trimmed = newDoc.trim();
    if (!trimmed) return;
    setCustomDocs((prev) => [...prev, trimmed]);
    setChecked((prev) => new Set(prev).add(trimmed));
    setNewDoc("");
  }

  const allDocNames = [...suggestedRequirementNames, ...customDocs];

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
          שם הבקשה
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue="מסמכים לפתיחת תיק"
          className={fieldClass("md")}
        />
        {state.fieldErrors?.name && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      {allDocNames.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-brand-purple/5 px-4 py-2.5 text-xs font-bold text-brand-purple">
            מסמכים מוצעים
          </div>
          <ul className="divide-y divide-border">
            {allDocNames.map((docName) => (
              <li key={docName} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <label className="flex flex-1 items-center gap-2.5 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    name="requirementName"
                    value={docName}
                    checked={checked.has(docName)}
                    onChange={() => toggle(docName)}
                    className="h-4 w-4 rounded border-border accent-brand-purple"
                  />
                  {docName}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newDoc}
          onChange={(e) => setNewDoc(e.currentTarget.value)}
          placeholder="הוספת מסמך נוסף"
          className={fieldClass("sm", "flex-1")}
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
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Plus className="h-3.5 w-3.5" />
          הוספה
        </button>
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" size="lg" className="w-full">
        המשך
      </Button>
    </form>
  );
}

// Step "Who should receive it?" — first-run (zero clients anywhere in the
// org) gets the single-client inline form straight from the design; a
// returning org gets an All clients / Selected clients choice.
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
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const boundAssign = assignClientsToTemplate.bind(null, draftId);
  const boundCreateAndAssign = createAndAssignClientToTemplate.bind(null, draftId);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (totalOrgClients === 0 && assignedClients.length === 0) {
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

  if (assignedClients.length > 0) {
    // Already assigned (resumed mid-flow) — straight to the next step.
    return (
      <div className="space-y-4 text-center" dir="rtl">
        <AnimatedCheckBadge size={28} className="mx-auto" />
        <p className="text-sm text-text-secondary">
          {assignedClients.length === 1
            ? `${assignedClients[0].clientName} נבחר/ה`
            : `${assignedClients.length} לקוחות נבחרו`}
        </p>
        <Link
          href={`/collections/new?draft=${draftId}&step=when`}
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setMode("all")}
          className={
            "flex-1 rounded-xl border p-4 text-start transition-colors " +
            (mode === "all" ? "border-brand-purple bg-brand-purple/5" : "border-border")
          }
        >
          <p className="text-sm font-semibold text-text-primary">כל הלקוחות</p>
          <p className="text-xs text-text-muted">{unassignedClients.length} לקוחות קיימים</p>
        </button>
        <button
          type="button"
          onClick={() => setMode("selected")}
          className={
            "flex-1 rounded-xl border p-4 text-start transition-colors " +
            (mode === "selected" ? "border-brand-purple bg-brand-purple/5" : "border-border")
          }
        >
          <p className="text-sm font-semibold text-text-primary">לקוחות נבחרים</p>
          <p className="text-xs text-text-muted">בחירה ידנית</p>
        </button>
      </div>

      <form action={boundAssign} className="space-y-3">
        {mode === "selected" && (
          <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-border p-3">
            {unassignedClients.map((client) => (
              <li key={client.id}>
                <label className="flex items-center gap-2 text-sm text-text-primary">
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
        {mode === "all" &&
          unassignedClients.map((client) => (
            <input key={client.id} type="hidden" name="clientId" value={client.id} />
          ))}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={mode === "selected" && selectedIds.size === 0}
        >
          המשך
        </Button>
      </form>
    </div>
  );
}

function WhenStep({ draftId }: { draftId: string }) {
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [defaultScheduleValue] = useState(() => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16));

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
  const recipientLabel =
    assignedClients.length === 1 ? assignedClients[0].clientName : `${assignedClients.length} לקוחות`;
  const whenLabel = sendMode === "schedule" ? "מתוזמן" : "עכשיו";

  return (
    <form action={boundSend} dir="rtl">
      <input type="hidden" name="sendMode" value={sendMode} />
      {sendMode === "schedule" && <input type="hidden" name="scheduledFor" value={scheduledFor} />}
      <input
        type="hidden"
        name="redirectTo"
        value={`/collections/new?draft=${draftId}&step=success`}
      />
      {assignedClients.map((c) => (
        <input key={c.clientId} type="hidden" name="clientId" value={c.clientId} />
      ))}

      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="border-b border-border bg-surface-muted/40 px-6 py-4 text-center">
          <p className="text-[11px] font-bold tracking-wide text-text-muted uppercase">בקשת האיסוף</p>
          <p className="text-base font-bold text-text-primary">{definitionName}</p>
        </div>
        <div className="space-y-0 px-6">
          <div className="flex items-center justify-between gap-3 border-b border-border py-3">
            <span className="flex items-center gap-2 text-xs text-text-muted">
              <FileText className="h-3.5 w-3.5" />
              מה נשלח
            </span>
            <span className="text-sm font-semibold text-text-primary">{requirements.length} מסמכים</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border py-3">
            <span className="flex items-center gap-2 text-xs text-text-muted">
              <UserPlus className="h-3.5 w-3.5" />
              למי
            </span>
            <span className="text-sm font-semibold text-text-primary">{recipientLabel}</span>
          </div>
          <div className="flex items-center justify-between gap-3 py-3">
            <span className="text-xs text-text-muted">מתי</span>
            <span className="text-sm font-semibold text-text-primary">{whenLabel}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 bg-brand-emerald/5 px-6 py-3 text-sm font-semibold text-brand-emerald">
          <span>חיבורים</span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            WhatsApp + Drive מחוברים
          </span>
        </div>
        <div className="space-y-2 px-6 py-5">
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error === "no-clients-selected"
                ? "יש לבחור לפחות לקוח אחד לשליחה."
                : "יש לבחור מועד עתידי לתזמון השליחה."}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full">
            <Send className="h-4 w-4" />
            אישור ושליחה
          </Button>
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
            <h1 className="mb-5 text-xl font-bold text-text-primary">
              {step === "what" && "מה תרצו לבקש?"}
              {step === "who" && "למי לשלוח?"}
              {step === "when" && "מתי לשלוח את הבקשה?"}
              {step === "connect" && "נשארו שני חיבורים כדי לשלוח"}
              {step === "review" && "מוכנים לשלוח?"}
            </h1>

            {step === "what" && <WhatStep suggestedRequirementNames={props.suggestedRequirementNames ?? []} />}

            {step === "who" && props.draftId && (
              <WhoStep
                draftId={props.draftId}
                totalOrgClients={props.totalOrgClients ?? 0}
                assignedClients={props.assignedClients ?? []}
                unassignedClients={props.unassignedClients ?? []}
              />
            )}

            {step === "when" && props.draftId && <WhenStep draftId={props.draftId} />}

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
                  ? props.assignedClients!.length === 1
                    ? props.assignedClients![0].clientName
                    : `${props.assignedClients!.length} לקוחות`
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
