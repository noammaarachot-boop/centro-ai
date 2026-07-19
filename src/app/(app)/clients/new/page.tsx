import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "../actions";
import { ClientForm } from "../ClientForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";

export default async function NewClientPage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up px-6 py-10 lg:px-10">
      <Link
        href="/clients"
        className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        חזרה ללקוחות
      </Link>
      <PageHeader title="לקוח חדש" />
      <Card>
        <ClientForm action={createClient} submitLabel="שמירת לקוח" />
      </Card>
    </div>
  );
}
