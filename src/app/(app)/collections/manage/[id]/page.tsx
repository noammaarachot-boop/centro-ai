import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Copy, FileText, Sparkles, Trash2 } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { getService, listServiceRequirements } from "@/lib/data/services";
import { listClients } from "@/lib/data/clients";
import { findClientIdsWithActiveRequest, listActiveRequestsForTemplate } from "@/lib/data/templates";
import {
  addTemplateRequirement,
  addTemplateRequirementWithClarification,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from "../../../templates/actions";
import { resolveRequirementSemantics } from "@/lib/requirementSemanticsActions";
import { requiresClarification, type RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";
import { WHATSAPP_NOT_READY_MESSAGE, DRIVE_NOT_READY_MESSAGE } from "@/lib/integrationRequirements";
import { TemplateForm } from "../../../templates/TemplateForm";
import { TemplateRequirementRow } from "../../../templates/TemplateRequirementRow";
import { TemplateSendToClients } from "../../../templates/TemplateSendToClients";
import { TemplateActiveRequests } from "../../../templates/TemplateActiveRequests";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { fieldClass } from "@/components/app/FormField";

// First-Send Journey — this is the retired /templates/[id] page, moved
// here so its route matches the new "בקשות איסוף" nav entry / IA. Nothing
// about its actual behavior changed: same components, same actions (still
// living in src/app/(app)/templates/, which is no longer itself a routed
// folder — see that directory's actions.ts header comment), just the
// route and the user-facing copy.
const ERROR_MESSAGES: Record<string, string> = {
  "has-active-requests": "לא ניתן למחוק את התבנית כרגע — יש לה בקשות פעילות. אפשר למחוק לאחר שהן יושלמו או ייסגרו.",
  "template-deleted": "התבנית הזו נמחקה ואי אפשר לשלוח ממנה בקשות חדשות.",
  "invalid-schedule": "יש לבחור מועד עתידי לתזמון השליחה.",
  "no-clients-selected": "יש לבחור לפחות לקוח אחד לשליחה.",
  no_active_document_requirements:
    "לא הוגדרו מסמכים לבקשה זו. יש להגדיר לפחות מסמך אחד לפני השליחה — Centro לעולם לא שולח בקשה כללית ללא רשימת מסמכים.",
  "requirement-name": "יש להזין שם מסמך.",
  "client-fields": "יש למלא שם וטלפון עבור הלקוח החדש.",
  // Repeat-use rework, point 5 — sendTemplateRequest's own server-side
  // integration-readiness guard, now enforced regardless of which UI
  // triggered the send (this page's own TemplateSendToClients drawer, or
  // the /collections/new wizard).
  "whatsapp-not-ready": WHATSAPP_NOT_READY_MESSAGE,
  "drive-not-ready": DRIVE_NOT_READY_MESSAGE,
};

export default async function CollectionRequestManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    sent?: string;
    scheduled?: string;
    alreadyActive?: string;
    clarifyName?: string;
    clarifyQuestion?: string;
  }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error, sent, scheduled, alreadyActive, clarifyName, clarifyQuestion } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (!organization) notFound();

  const template = await getService(session.organizationId, id);
  if (!template) notFound();
  if (template.collectionMode !== "on_demand") notFound();

  const [requirements, allClients, activeRequests] = await Promise.all([
    listServiceRequirements(id),
    listClients(session.organizationId),
    listActiveRequestsForTemplate(session.organizationId, id),
  ]);
  const clientIdsWithActiveRequest = await findClientIdsWithActiveRequest(
    session.organizationId,
    id,
    allClients.map((c) => c.id)
  );
  // Every client is shown in the send drawer, not just the ones without an
  // active request — marked + disabled per the approved sketch, so it's
  // obvious why one can't be picked rather than silently missing from the
  // list.
  const pickableClients = allClients.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    hasActiveRequest: clientIdsWithActiveRequest.has(c.id),
  }));

  const boundUpdate = updateTemplate.bind(null, template.id);
  const boundDelete = deleteTemplate.bind(null, template.id);
  const boundDuplicate = duplicateTemplate.bind(null, template.id);
  const boundAddRequirement = addTemplateRequirement.bind(null, template.id);
  const boundAddRequirementWithClarification = addTemplateRequirementWithClarification.bind(null, template.id);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/collections"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לבקשות איסוף
        </Link>
        <PageHeader
          title={template.name}
          actions={
            <div className="flex items-center gap-2">
              <form action={boundDuplicate}>
                <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  <Copy className="h-3.5 w-3.5" />
                  שכפול
                </button>
              </form>
              <TemplateSendToClients templateId={template.id} clients={pickableClients} />
            </div>
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

      {(sent || scheduled || alreadyActive) &&
        (Number(sent) > 0 || Number(scheduled) > 0 || Number(alreadyActive) > 0) && (
          <p className="animate-fade-in-up rounded-xl border border-brand-emerald/25 bg-brand-emerald/5 px-4 py-3 text-sm font-medium text-text-primary">
            {Number(sent) > 0 && `נשלח ל-${sent} לקוחות. `}
            {Number(scheduled) > 0 && `${scheduled} בקשות תוזמנו לשליחה. `}
            {Number(alreadyActive) > 0 &&
              `${alreadyActive} לקוחות דולגו — כבר יש להם בקשה פעילה מהתבנית הזו.`}
          </p>
        )}

      {template.isSampleTemplate && (
        <div className="flex items-start gap-2.5 rounded-xl border border-brand-purple/25 bg-brand-purple/5 px-4 py-3 text-sm text-text-secondary">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-purple" />
          <p>
            זו בקשת איסוף לדוגמה שנוצרה בעבר. אפשר לערוך, להסיר, לשנות שם או להוסיף מסמכים
            ולהתאים אותה באופן מלא בכל עת.
          </p>
        </div>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי הבקשה</h2>
        <TemplateForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{ name: template.name, description: template.description }}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">מסמכים נדרשים</h2>
        <p className="mb-4 text-sm text-text-muted">
          המסמכים שיתבקשו מכל לקוח שהבקשה הזו תישלח אליו. אפשר לגרור את סדר התצוגה
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
            {requirements.map((requirement, index) => {
              const spec = requirement.semanticSpec as RequirementSemanticSpec | null;
              const ambiguous = spec && requiresClarification(spec);
              return (
                <li key={requirement.id}>
                  <TemplateRequirementRow
                    templateId={template.id}
                    requirementId={requirement.id}
                    name={requirement.name}
                    isFirst={index === 0}
                    isLast={index === requirements.length - 1}
                  />
                  {ambiguous && (
                    // Semantic requirement engine — this row was saved via
                    // the bulk wizard step (createCollectionRequestDraft),
                    // which never blocks on ambiguity; resolved here,
                    // before the request is ever sent.
                    <form
                      action={resolveRequirementSemantics.bind(null, requirement.id)}
                      className="mt-1 space-y-1.5 rounded-lg border border-brand-purple/30 bg-brand-purple/5 p-3"
                    >
                      <p className="text-xs font-medium text-text-primary">{spec!.clarifyingQuestion}</p>
                      <div className="flex items-center gap-2">
                        <input
                          name="clarificationAnswer"
                          type="text"
                          placeholder="תשובה קצרה..."
                          className={fieldClass("sm", "flex-1")}
                        />
                        <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                          אישור
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {clarifyQuestion ? (
          <form
            action={boundAddRequirementWithClarification}
            className="space-y-2 rounded-xl border border-brand-purple/30 bg-brand-purple/5 p-4"
          >
            <p className="text-sm font-medium text-text-primary">{clarifyQuestion}</p>
            <input type="hidden" name="name" value={clarifyName ?? ""} />
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
              placeholder="לדוגמה: תעודת זהות"
              className={fieldClass("md", "flex-1")}
            />
            <button type="submit" className={buttonVariants({ variant: "secondary" })}>
              הוספת מסמך
            </button>
          </form>
        )}
      </Card>

      <TemplateActiveRequests requests={activeRequests} />

      <ConfirmDialog
        title="מחיקת בקשת איסוף"
        description={`למחוק את "${template.name}"? פעולה זו אינה הפיכה. אם לבקשה יש היסטוריית שליחות, המחיקה תיחסם.`}
        confirmLabel="מחיקה"
        formAction={boundDelete}
        triggerClassName="inline-flex items-center gap-1.5 text-sm font-medium text-danger transition-colors hover:underline"
        trigger={
          <>
            <Trash2 className="h-4 w-4" />
            מחיקת בקשת איסוף
          </>
        }
      />
    </div>
  );
}
