import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Pause, Play, Trash2, Users, X } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getService,
  listServiceClients,
  listServiceRequirements,
} from "@/lib/data/services";
import {
  addRequirement,
  addRequirementWithClarification,
  deleteService,
  pauseServiceAutomation,
  removeRequirement,
  resumeServiceAutomation,
  updateService,
} from "../actions";
import { ServiceForm } from "../ServiceForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { ServiceScheduleOverrideCard } from "@/components/app/ServiceScheduleOverrideCard";
import { ServiceFrequencyCard } from "@/components/app/ServiceFrequencyCard";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { HelpTip } from "@/components/app/HelpTip";
import { fieldClass } from "@/components/app/FormField";
import { resolveScheduleConfig } from "@/lib/businessHours";
import { getOrganization } from "@/lib/data/organizations";

export default async function ServiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; clarifyName?: string; clarifyDescription?: string; clarifyQuestion?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error, clarifyName, clarifyDescription, clarifyQuestion } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (!organization) notFound();

  const service = await getService(session.organizationId, id);
  if (!service) notFound();
  // Product Evolution M9 — gated on this specific Service's own mode, not
  // the organization's (an org can have both kinds now); a Template lives
  // at /templates/[id], not here.
  if (service.collectionMode !== "recurring") notFound();

  const [requirements, assignedClients] = await Promise.all([
    listServiceRequirements(id),
    listServiceClients(session.organizationId, id),
  ]);

  const hasScheduleOverrides = !!(
    service.businessHoursStartOverride ||
    service.businessHoursEndOverride ||
    service.businessDaysOverride ||
    service.reminderIntervalDaysOverride ||
    service.inactivityTimeoutMinutesOverride ||
    service.collectionDayOfMonthOverride
  );
  const effectiveSchedule = resolveScheduleConfig(organization, service);

  const boundUpdate = updateService.bind(null, service.id);
  const boundDelete = deleteService.bind(null, service.id);
  const boundAddRequirement = addRequirement.bind(null, service.id);
  const boundAddRequirementWithClarification = addRequirementWithClarification.bind(null, service.id);
  const isPaused = !!service.automationPausedAt;

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/services"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לאיסוף מחזורי
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <PageHeader title={service.name} />
          {isPaused && <Badge tone="warning">מושהה</Badge>}
        </div>
      </div>

      {error === "has-history" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן למחוק איסוף מחזורי שיש לו היסטוריית בקשות.
        </p>
      )}

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {isPaused ? (
              <Pause className="h-5 w-5 shrink-0 text-warning" />
            ) : (
              <Play className="h-5 w-5 shrink-0 text-brand-emerald" />
            )}
            <div>
              <div className="flex items-center gap-1">
                <p className="text-sm font-semibold text-text-primary">
                  {isPaused ? "האיסוף המחזורי הזה מושהה" : "האיסוף המחזורי הזה פעיל"}
                </p>
                <HelpTip label="מה זה עושה?">
                  {isPaused ? (
                    <>
                      כרגע לא ייפתחים מחזורים חדשים ולא נשלחות הודעות אוטומטיות ללקוחות
                      המשויכים לאיסוף המחזורי הזה — איסופים מחזוריים אחרים ממשיכים לפעול
                      כרגיל.
                      <br />
                      <br />
                      שום מידע לא נמחק. בלחיצה על &quot;חידוש&quot; הכול חוזר לפעול.
                    </>
                  ) : (
                    <>
                      השהיה תפסיק לפתוח מחזורים חדשים ולשלוח הודעות אוטומטיות ללקוחות
                      המשויכים לאיסוף המחזורי הזה בלבד — איסופים מחזוריים אחרים לא יושפעו.
                      <br />
                      <br />
                      שום מידע לא יימחק, ואפשר לחדש בכל רגע.
                    </>
                  )}
                </HelpTip>
              </div>
              <p className="text-xs text-text-muted">
                {isPaused
                  ? "לא ייפתחו מחזורים חדשים ולא יישלחו הודעות אוטומטיות עבור לקוחות המשויכים."
                  : "מחזורים חדשים נפתחים אוטומטית, והודעות/תזכורות נשלחות ללקוחות כרגיל."}
              </p>
            </div>
          </div>
          <form action={isPaused ? resumeServiceAutomation.bind(null, service.id) : pauseServiceAutomation.bind(null, service.id)}>
            <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              {isPaused ? "חידוש" : "השהיה"}
            </button>
          </form>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי האיסוף המחזורי</h2>
        <ServiceForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{
            name: service.name,
            description: service.description,
          }}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">דרישות מסמכים</h2>
        <p className="mb-4 text-sm text-text-muted">
          המסמכים שיתבקשו מכל לקוח המשויך לאיסוף המחזורי הזה, בכל מחזור.
        </p>

        {requirements.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="עדיין לא הוגדרו דרישות מסמכים"
            description="הוסיפו את דרישת המסמך הראשונה בטופס שלמטה."
          />
        ) : (
          <ul className="mb-5 space-y-2">
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted/40 px-4 py-3 transition-colors hover:border-brand-purple/20"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {requirement.name}
                  </p>
                  {requirement.description && (
                    <p className="text-xs text-text-muted">{requirement.description}</p>
                  )}
                </div>
                <form
                  action={removeRequirement.bind(null, service.id, requirement.id)}
                >
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

        {clarifyQuestion ? (
          // Semantic requirement engine — the AI couldn't confidently
          // interpret the free text alone; asks the OFFICE USER (never the
          // client) one short question before this requirement is saved.
          <form
            action={boundAddRequirementWithClarification}
            className="space-y-2 rounded-xl border border-brand-purple/30 bg-brand-purple/5 p-4"
          >
            <p className="text-sm font-medium text-text-primary">{clarifyQuestion}</p>
            <input type="hidden" name="name" value={clarifyName ?? ""} />
            <input type="hidden" name="description" value={clarifyDescription ?? ""} />
            <div className="flex items-center gap-2">
              <input
                name="clarificationAnswer"
                type="text"
                autoFocus
                placeholder="תשובה קצרה..."
                className={fieldClass("md", "flex-1")}
              />
              <button type="submit" className={buttonVariants({ variant: "primary" })}>
                אישור
              </button>
            </div>
          </form>
        ) : (
          <form action={boundAddRequirement} className="flex items-center gap-2">
            <input
              name="name"
              type="text"
              required
              placeholder="לדוגמה: דף חשבון בנק"
              className={fieldClass("md", "flex-1")}
            />
            <button type="submit" className={buttonVariants({ variant: "secondary" })}>
              הוספת דרישה
            </button>
          </form>
        )}
      </Card>

      <ServiceFrequencyCard
        serviceId={service.id}
        collectionFrequencyIntervalMonths={service.collectionFrequencyIntervalMonths}
      />

      <ServiceScheduleOverrideCard
        serviceId={service.id}
        name="כללי תזכורות"
        hasOverrides={hasScheduleOverrides}
        businessHoursStart={effectiveSchedule.businessHoursStart}
        businessHoursEnd={effectiveSchedule.businessHoursEnd}
        businessDays={effectiveSchedule.businessDays}
        reminderIntervalDays={effectiveSchedule.reminderIntervalDays}
        inactivityTimeoutMinutes={effectiveSchedule.inactivityTimeoutMinutes}
        collectionDayOfMonth={effectiveSchedule.collectionDayOfMonth}
        returnTo={`/services/${service.id}`}
      />

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">לקוחות משויכים</h2>
        {assignedClients.length === 0 ? (
          <EmptyState
            icon={Users}
            title="אין לקוחות משויכים"
            description="שייכו איסוף מחזורי ללקוח מתוך עמוד הלקוח כדי לראות אותו כאן."
          />
        ) : (
          <ul className="space-y-2">
            {assignedClients.map((assignment) => (
              <li key={assignment.assignmentId}>
                <Link
                  href={`/clients/${assignment.clientId}`}
                  className="block rounded-xl border border-border bg-surface-muted/40 px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-brand-purple/30 hover:text-brand-purple"
                >
                  {assignment.clientName}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        title="מחיקת איסוף מחזורי"
        description={`למחוק את "${service.name}"? פעולה זו אינה הפיכה. אם יש לו היסטוריית בקשות איסוף, המחיקה תיחסם.`}
        confirmLabel="מחיקה"
        formAction={boundDelete}
        triggerClassName="inline-flex items-center gap-1.5 text-sm font-medium text-danger transition-colors hover:underline"
        trigger={
          <>
            <Trash2 className="h-4 w-4" />
            מחיקה
          </>
        }
      />
    </div>
  );
}
