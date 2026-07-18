import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
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
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div>
        <Link
          href="/services"
          className="text-sm text-text-muted hover:text-brand-purple"
        >
          ← חזרה לשירותים
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-text-primary">
          {service.name}
        </h1>
      </div>

      {error === "has-history" && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          לא ניתן למחוק שירות שיש לו היסטוריית בקשות איסוף.
        </p>
      )}

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          פרטי שירות
        </h2>
        <ServiceForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{
            name: service.name,
            description: service.description,
          }}
        />
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          דרישות מסמכים
        </h2>
        <p className="mb-4 text-sm text-text-muted">
          המסמכים שיתבקשו מכל לקוח המשויך לשירות זה בכל מחזור איסוף.
        </p>

        {requirements.length === 0 ? (
          <p className="mb-4 text-sm text-text-muted">
            עדיין לא הוגדרו דרישות מסמכים.
          </p>
        ) : (
          <ul className="mb-4 space-y-2">
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className="flex items-center justify-between rounded-xl border border-border px-4 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {requirement.name}
                  </p>
                  {requirement.description && (
                    <p className="text-xs text-text-muted">
                      {requirement.description}
                    </p>
                  )}
                </div>
                <form
                  action={removeRequirement.bind(
                    null,
                    service.id,
                    requirement.id
                  )}
                >
                  <button
                    type="submit"
                    className="text-xs font-medium text-danger hover:underline"
                  >
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
            className="flex-1 rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
          />
          <button
            type="submit"
            className="rounded-full border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
          >
            הוספת דרישה
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          לקוחות משויכים
        </h2>
        {assignedClients.length === 0 ? (
          <p className="text-sm text-text-muted">
            אין לקוחות המשויכים לשירות זה עדיין. שייכו שירות ללקוח מתוך עמוד
            הלקוח.
          </p>
        ) : (
          <ul className="space-y-2">
            {assignedClients.map((assignment) => (
              <li key={assignment.assignmentId}>
                <Link
                  href={`/clients/${assignment.clientId}`}
                  className="block rounded-xl border border-border px-4 py-2.5 text-sm text-text-primary hover:border-brand-purple"
                >
                  {assignment.clientName}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={boundDelete}>
        <button
          type="submit"
          className="flex items-center gap-1.5 text-sm font-medium text-danger hover:underline"
        >
          <Trash2 className="h-4 w-4" />
          מחיקת שירות
        </button>
      </form>
    </div>
  );
}
