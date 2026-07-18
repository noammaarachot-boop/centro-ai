import Link from "next/link";
import { Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listServices } from "@/lib/data/services";

export default async function ServicesPage() {
  const session = await requireSession();
  const services = await listServices(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">שירותים</h1>
        <Link
          href="/services/new"
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-4 py-2.5 text-sm font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          שירות חדש
        </Link>
      </div>

      {services.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface-muted px-6 py-10 text-center text-sm text-text-muted">
          עדיין אין שירותים. שירותים מגדירים אילו מסמכים נדרשים מהלקוחות בכל
          מחזור איסוף.
        </p>
      ) : (
        <ul className="space-y-3">
          {services.map((service) => (
            <li key={service.id}>
              <Link
                href={`/services/${service.id}`}
                className="block rounded-2xl border border-border bg-surface p-5 shadow-card transition-colors hover:border-brand-purple"
              >
                <p className="font-medium text-text-primary">{service.name}</p>
                {service.description && (
                  <p className="mt-1 text-sm text-text-secondary">
                    {service.description}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
