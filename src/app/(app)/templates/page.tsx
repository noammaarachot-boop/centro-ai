import { notFound } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";

// Product Evolution M4 — a minimal placeholder so the sidebar's "תבניות"
// link and the one-time dashboard's CTA aren't dead links; Milestone 5
// replaces this with the real Templates CRUD (create/edit/delete/
// duplicate/reorder documents, the Template Library). Guarded to
// one-time-workflow organizations only — a Template is a bare `services`
// row for that workflow specifically (see ARCHITECTURE.md); a recurring
// organization manages its Services through /services instead.
export default async function TemplatesPage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType !== "one_time") notFound();

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="תבניות"
        description="תבנית מגדירה אילו מסמכים לבקש ומאיזה לקוחות — ואפשר לשלוח אותה שוב ושוב."
      />
      <EmptyState
        icon={LayoutTemplate}
        title="בקרוב"
        description="יצירת תבניות, ספריית תבניות מוצעות, ושליחת בקשות ללקוחות — בפיתוח."
      />
    </div>
  );
}
