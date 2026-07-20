import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { createService } from "../actions";
import { ServiceForm } from "../ServiceForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";

export default async function NewServicePage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType === "one_time") notFound();

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up px-6 py-10 lg:px-10">
      <Link
        href="/services"
        className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        חזרה לתבניות
      </Link>
      <PageHeader title="תבנית חדשה" />
      <Card>
        <ServiceForm action={createService} submitLabel="שמירת תבנית" />
      </Card>
    </div>
  );
}
