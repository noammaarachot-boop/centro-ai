import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getClient,
  listClientServices,
  listUnassignedServicesForClient,
} from "@/lib/data/clients";
import { assignService, deleteClient, unassignService, updateClient } from "../actions";
import { ClientForm } from "../ClientForm";
import { createCollectionRequest } from "../../collections/actions";

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error } = await searchParams;

  const client = await getClient(session.organizationId, id);
  if (!client) notFound();

  const [assignedServices, unassignedServices] = await Promise.all([
    listClientServices(session.organizationId, id),
    listUnassignedServicesForClient(session.organizationId, id),
  ]);

  const boundUpdate = updateClient.bind(null, client.id);
  const boundDelete = deleteClient.bind(null, client.id);
  const boundAssign = assignService.bind(null, client.id);

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div>
        <Link
          href="/clients"
          className="text-sm text-text-muted hover:text-brand-purple"
        >
          ← חזרה ללקוחות
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-text-primary">
          {client.name}
        </h1>
      </div>

      {error === "has-history" && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          לא ניתן למחוק לקוח שיש לו היסטוריית בקשות איסוף.
        </p>
      )}
      {error === "period-required" && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          נא להזין תקופה לפני פתיחת בקשת איסוף.
        </p>
      )}

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          פרטי לקוח
        </h2>
        <ClientForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{
            name: client.name,
            phone: client.phone,
            email: client.email,
            notes: client.notes,
          }}
        />
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          שירותים משויכים
        </h2>
        {assignedServices.length === 0 ? (
          <p className="mb-4 text-sm text-text-muted">
            אין שירותים משויכים ללקוח זה.
          </p>
        ) : (
          <ul className="mb-4 space-y-2">
            {assignedServices.map((assignment) => (
              <li
                key={assignment.assignmentId}
                className="rounded-xl border border-border px-4 py-2.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-primary">
                    {assignment.serviceName}
                  </span>
                  <form
                    action={unassignService.bind(
                      null,
                      client.id,
                      assignment.assignmentId
                    )}
                  >
                    <button
                      type="submit"
                      className="text-xs font-medium text-danger hover:underline"
                    >
                      הסרת שיוך
                    </button>
                  </form>
                </div>
                <form
                  action={createCollectionRequest.bind(
                    null,
                    client.id,
                    assignment.serviceId
                  )}
                  className="mt-2 flex items-center gap-2"
                >
                  <input
                    name="periodLabel"
                    type="text"
                    required
                    placeholder="תקופה, למשל 2026-07"
                    className="flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-xs text-text-primary outline-none focus:border-brand-purple"
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                  >
                    פתיחת בקשת איסוף
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {unassignedServices.length > 0 && (
          <form action={boundAssign} className="flex items-center gap-2">
            <select
              name="serviceId"
              required
              className="flex-1 rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
            >
              {unassignedServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-full border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
            >
              שיוך שירות
            </button>
          </form>
        )}
      </section>

      <form action={boundDelete}>
        <button
          type="submit"
          className="flex items-center gap-1.5 text-sm font-medium text-danger hover:underline"
        >
          <Trash2 className="h-4 w-4" />
          מחיקת לקוח
        </button>
      </form>
    </div>
  );
}
