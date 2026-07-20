import Link from "next/link";
import { notFound } from "next/navigation";
import { LayoutTemplate, Plus, Sparkles } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { listServices, listServiceRequirements } from "@/lib/data/services";
import { suggestTemplateLibrary } from "@/lib/ai/businessCategorySuggestions";
import { seedExampleTemplates, createTemplateFromLibrary } from "./actions";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

// Product Evolution M5 — the real Templates list, replacing Milestone 4's
// placeholder. A Template is a bare `services` row for a one-time-workflow
// organization, so this reuses listServices/listServiceRequirements
// directly rather than a parallel data layer.
export default async function TemplatesPage() {
  const session = await requireSession();
  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType !== "one_time") notFound();

  await seedExampleTemplates(session.organizationId);

  const templates = await listServices(session.organizationId);
  const withCounts = await Promise.all(
    templates.map(async (template) => ({
      template,
      requirementCount: (await listServiceRequirements(template.id)).length,
    }))
  );

  const library = await suggestTemplateLibrary(
    organization.businessCategory,
    organization.businessCategoryCustomLabel
  );
  const existingNames = new Set(templates.map((t) => t.name));
  const availableLibraryEntries = library.filter((entry) => !existingNames.has(entry.name));

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        title="תבניות"
        description="תבנית מגדירה אילו מסמכים לבקש ומאיזה לקוחות — ואפשר לשלוח אותה שוב ושוב."
        actions={
          <Link href="/templates/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus className="h-4 w-4" />
            תבנית חדשה
          </Link>
        }
      />

      {withCounts.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="עדיין אין תבניות"
          description="צרו תבנית משלכם, או התחילו מאחת מספריית התבניות שלמטה."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {withCounts.map(({ template, requirementCount }) => (
            <Link key={template.id} href={`/templates/${template.id}`}>
              <Card interactive glow="purple" padding="sm" className="h-full">
                <p className="text-sm font-semibold text-text-primary">{template.name}</p>
                {template.description && (
                  <p className="mt-1 text-xs text-text-muted">{template.description}</p>
                )}
                <p className="mt-2 text-xs text-text-muted">
                  {requirementCount} {requirementCount === 1 ? "מסמך נדרש" : "מסמכים נדרשים"}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {availableLibraryEntries.length > 0 && (
        <Card>
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-purple" />
            <h2 className="text-sm font-semibold text-text-primary">ספריית תבניות</h2>
          </div>
          <p className="mb-4 text-xs text-text-muted">
            תבניות מוצעות לפי סוג העסק שלכם — נקודת התחלה שאפשר להתאים באופן מלא.
          </p>
          <ul className="space-y-2">
            {availableLibraryEntries.map((entry) => (
              <li
                key={entry.canonicalKey}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted/40 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">{entry.name}</p>
                  <p className="text-xs text-text-muted">
                    {entry.suggestedRequirements.length} מסמכים מוצעים
                  </p>
                </div>
                <form action={createTemplateFromLibrary}>
                  <input type="hidden" name="canonicalKey" value={entry.canonicalKey ?? ""} />
                  <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    הוספה
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
