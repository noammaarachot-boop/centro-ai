import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Trash2, Users, X } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getService,
  listServiceClients,
  listServiceRequirements,
} from "@/lib/data/services";
import {
  addRequirement,
  deleteService,
  removeRequirement,
  updateService,
} from "../actions";
import { ServiceForm } from "../ServiceForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";

export default async function ServiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error } = await searchParams;

  const service = await getService(session.organizationId, id);
  if (!service) notFound();

  const [requirements, assignedClients] = await Promise.all([
    listServiceRequirements(id),
    listServiceClients(session.organizationId, id),
  ]);

  const boundUpdate = updateService.bind(null, service.id);
  const boundDelete = deleteService.bind(null, service.id);
  const boundAddRequirement = addRequirement.bind(null, service.id);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/services"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לשירותים
        </Link>
        <PageHeader title={service.name} />
      </div>

      {error === "has-history" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן למחוק שירות שיש לו היסטוריית בקשות איסוף.
        </p>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי שירות</h2>
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
          המסמכים שיתבקשו מכל לקוח המשויך לשירות זה בכל מחזור איסוף.
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

        <form action={boundAddRequirement} className="flex items-center gap-2">
          <input
            name="name"
            type="text"
            required
            placeholder="לדוגמה: דף חשבון בנק"
            className="flex-1 rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
          <button type="submit" className={buttonVariants({ variant: "secondary" })}>
            הוספת דרישה
          </button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">לקוחות משויכים</h2>
        {assignedClients.length === 0 ? (
          <EmptyState
            icon={Users}
            title="אין לקוחות משויכים"
            description="שייכו שירות ללקוח מתוך עמוד הלקוח כדי לראות אותו כאן."
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

      <form action={boundDelete}>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-danger transition-colors hover:underline"
        >
          <Trash2 className="h-4 w-4" />
          מחיקת שירות
        </button>
      </form>
    </div>
  );
}
