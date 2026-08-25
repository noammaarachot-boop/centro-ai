import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listServices } from "@/lib/data/services";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

// Product Evolution M9 — every organization can create Recurring
// Collections regardless of how it started onboarding; the old
// workflowType-based notFound() gate is gone (see services.collectionMode).
export default async function ServicesPage() {
  const session = await requireSession();
  const services = await listServices(session.organizationId, "recurring");

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-4 py-10 sm:px-6 lg:px-10">
      <PageHeader
        title="איסוף מחזורי"
        description="כל שורה כאן היא סוג לקוח שמקבל מחזורי איסוף אוטומטיים — Centro פותח את המחזור הבא לבד, לפי התדירות שתגדירו."
        actions={
          <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" />
            איסוף מחזורי חדש
          </Link>
        }
      />

      {services.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="עדיין אין איסוף מחזורי"
          description="הגדירו את הראשון כדי לקבוע אילו מסמכים נדרשים מהלקוחות ובאיזו תדירות."
          action={
            <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
              <Plus className="h-4 w-4" />
              הוספת איסוף מחזורי ראשון
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3">
          {services.map((service) => (
            <li key={service.id}>
              <Link href={`/services/${service.id}`} className="block">
                <Card interactive glow="purple">
                  <p className="font-medium text-text-primary">{service.name}</p>
                  {service.description && (
                    <p className="mt-1 text-sm text-text-secondary">
                      {service.description}
                    </p>
                  )}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
