import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listServices } from "@/lib/data/services";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

export default async function ServicesPage() {
  const session = await requireSession();
  const services = await listServices(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="שירותים"
        description="שירותים מגדירים אילו מסמכים נדרשים מהלקוחות בכל מחזור איסוף."
        actions={
          <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" />
            שירות חדש
          </Link>
        }
      />

      {services.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="עדיין אין שירותים"
          description="הגדירו את השירות הראשון כדי לקבוע אילו מסמכים נדרשים מהלקוחות בכל מחזור איסוף."
          action={
            <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
              <Plus className="h-4 w-4" />
              הוספת שירות ראשון
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
