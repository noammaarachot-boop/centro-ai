import Link from "next/link";
import { notFound } from "next/navigation";
import { Layers, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listServices } from "@/lib/data/services";
import { getOrganization } from "@/lib/data/organizations";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

export default async function ServicesPage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType === "one_time") notFound();

  const services = await listServices(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="תבניות"
        description="תבניות מגדירות אילו מסמכים נדרשים מהלקוחות בכל מחזור איסוף."
        actions={
          <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" />
            תבנית חדשה
          </Link>
        }
      />

      {services.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="עדיין אין תבניות"
          description="הגדירו את התבנית הראשונה כדי לקבוע אילו מסמכים נדרשים מהלקוחות בכל מחזור איסוף."
          action={
            <Link href="/services/new" className={buttonVariants({ variant: "primary" })}>
              <Plus className="h-4 w-4" />
              הוספת תבנית ראשונה
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
