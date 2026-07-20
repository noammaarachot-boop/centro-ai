import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Copy, FileText, Sparkles, Trash2 } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import {
  getService,
  listServiceClients,
  listServiceRequirements,
  listUnassignedClientsForService,
} from "@/lib/data/services";
import {
  addTemplateRequirement,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from "../actions";
import { TemplateForm } from "../TemplateForm";
import { TemplateRequirementRow } from "../TemplateRequirementRow";
import { TemplateClientAssignment } from "../TemplateClientAssignment";
import { TemplateSendRequest } from "../TemplateSendRequest";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { fieldClass } from "@/components/app/FormField";

// M8 hardening — every redirect-with-?error= from actions.ts needs a real
// message here; before this, only "has-history" was ever displayed, so a
// rejected action (e.g. scheduling a send in the past) redirected the user
// right back to the page with no visible feedback at all.
const ERROR_MESSAGES: Record<string, string> = {
  "has-history": "לא ניתן למחוק תבנית שיש לה היסטוריית בקשות איסוף.",
  "invalid-schedule": "יש לבחור מועד עתידי לתזמון השליחה.",
  "no-clients-selected": "יש לבחור לפחות לקוח אחד לשליחה.",
  "requirement-name": "יש להזין שם מסמך.",
  "client-fields": "יש למלא שם וטלפון עבור הלקוח החדש.",
};

export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; sent?: string; scheduled?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error, sent, scheduled } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType !== "one_time") notFound();

  const template = await getService(session.organizationId, id);
  if (!template) notFound();

  const requirements = await listServiceRequirements(id);
  const assignedClients = await listServiceClients(session.organizationId, id);
  const unassignedClients = await listUnassignedClientsForService(session.organizationId, id);

  const boundUpdate = updateTemplate.bind(null, template.id);
  const boundDelete = deleteTemplate.bind(null, template.id);
  const boundDuplicate = duplicateTemplate.bind(null, template.id);
  const boundAddRequirement = addTemplateRequirement.bind(null, template.id);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/templates"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לתבניות
        </Link>
        <PageHeader
          title={template.name}
          actions={
            <form action={boundDuplicate}>
              <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <Copy className="h-3.5 w-3.5" />
                שכפול
              </button>
            </form>
          }
        />
      </div>

      {error && ERROR_MESSAGES[error] && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          {ERROR_MESSAGES[error]}
        </p>
      )}

      {(sent || scheduled) && (Number(sent) > 0 || Number(scheduled) > 0) && (
        <p className="animate-fade-in-up rounded-xl border border-brand-emerald/25 bg-brand-emerald/5 px-4 py-3 text-sm font-medium text-text-primary">
          {Number(sent) > 0 && `נשלח ל-${sent} לקוחות. `}
          {Number(scheduled) > 0 && `${scheduled} בקשות תוזמנו לשליחה.`}
        </p>
      )}

      {template.isSampleTemplate && (
        <div className="flex items-start gap-2.5 rounded-xl border border-brand-purple/25 bg-brand-purple/5 px-4 py-3 text-sm text-text-secondary">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-purple" />
          <p>
            זו תבנית לדוגמה. אפשר לערוך, להסיר, לשנות שם או להוסיף מסמכים ולהתאים אותה
            באופן מלא בכל עת — זו רק נקודת התחלה.
          </p>
        </div>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי תבנית</h2>
        <TemplateForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{ name: template.name, description: template.description }}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">מסמכים נדרשים</h2>
        <p className="mb-4 text-sm text-text-muted">
          המסמכים שיתבקשו מכל לקוח שהתבנית הזו תישלח אליו. אפשר לגרור את סדר התצוגה
          באמצעות החצים, לשנות שם בלחיצה על השדה, או להסיר.
        </p>

        {requirements.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="עדיין לא הוגדרו מסמכים"
            description="הוסיפו את המסמך הראשון בטופס שלמטה."
          />
        ) : (
          <ul className="mb-5 space-y-2">
            {requirements.map((requirement, index) => (
              <TemplateRequirementRow
                key={requirement.id}
                templateId={template.id}
                requirementId={requirement.id}
                name={requirement.name}
                isFirst={index === 0}
                isLast={index === requirements.length - 1}
              />
            ))}
          </ul>
        )}

        <form action={boundAddRequirement} className="flex items-center gap-2">
          <input
            name="name"
            type="text"
            required
            placeholder="לדוגמה: תעודת זהות"
            className={fieldClass("md", "flex-1")}
          />
          <button type="submit" className={buttonVariants({ variant: "secondary" })}>
            הוספת מסמך
          </button>
        </form>
      </Card>

      <TemplateClientAssignment
        templateId={template.id}
        assignedClients={assignedClients}
        unassignedClients={unassignedClients}
      />

      <TemplateSendRequest templateId={template.id} assignedClients={assignedClients} />

      <ConfirmDialog
        title="מחיקת תבנית"
        description={`למחוק את "${template.name}"? פעולה זו אינה הפיכה. אם לתבנית יש היסטוריית בקשות איסוף, המחיקה תיחסם.`}
        confirmLabel="מחיקת תבנית"
        formAction={boundDelete}
        triggerClassName="inline-flex items-center gap-1.5 text-sm font-medium text-danger transition-colors hover:underline"
        trigger={
          <>
            <Trash2 className="h-4 w-4" />
            מחיקת תבנית
          </>
        }
      />
    </div>
  );
}
