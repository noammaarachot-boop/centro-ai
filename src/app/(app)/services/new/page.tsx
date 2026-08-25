import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { createService } from "../actions";
import { ServiceForm } from "../ServiceForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";

export default async function NewServicePage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up px-4 py-10 sm:px-6 lg:px-10">
      <Link
        href="/services"
        className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        חזרה לאיסוף מחזורי
      </Link>
      <PageHeader title="איסוף מחזורי חדש" />
      <Card>
        <ServiceForm action={createService} submitLabel="שמירת תבנית" />
      </Card>
    </div>
  );
}
