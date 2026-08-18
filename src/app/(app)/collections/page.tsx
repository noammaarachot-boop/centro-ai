import Link from "next/link";
import { FileText, FolderKanban, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listTemplatesWithActiveCounts } from "@/lib/data/templates";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

// Template gallery — "בקשות איסוף" now shows on-demand templates as cards
// rather than a flat table of individual requests. Every number here
// (activeRequestCount, requirementCount) comes straight from
// listTemplatesWithActiveCounts (src/lib/data/templates.ts), which itself
// only reads the real collectionRequests/serviceDocumentRequirements
// tables via the state machine's own NON_TERMINAL_STATUSES — never a
// manual counter, never invented data.
//
// Recurring Collections (services.collectionMode="recurring") are
// deliberately not shown here or anywhere in nav right now (Sidebar.tsx's
// "איסוף מחזורי" is hidden) — the org's own choice to focus the visible UI
// on on-demand templates for now. Nothing about the recurring engine,
// routes, or data changed; only this screen's own content did.
export default async function CollectionsPage() {
  const session = await requireSession();
  const templates = await listTemplatesWithActiveCounts(session.organizationId);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="בקשות איסוף"
        description="תבניות בקשות המסמכים שלכם — כל תבנית אפשר לשלוח לכל לקוח, בכל זמן."
        actions={
          <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus className="h-4 w-4" />
            תבנית חדשה
          </Link>
        }
      />

      {templates.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="עדיין אין תבניות בקשות איסוף"
          description="צרו תבנית — למשל 'מסמכים לפתיחת תיק' — כדי להתחיל לשלוח בקשות ללקוחות."
          action={
            <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              יצירת תבנית ראשונה
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Link key={template.id} href={`/collections/manage/${template.id}`}>
              <Card interactive glow="purple" className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-text-primary">{template.name}</p>
                  {template.activeRequestCount > 0 && (
                    <Badge tone="blue">{template.activeRequestCount} פעילות</Badge>
                  )}
                </div>
                {template.description && (
                  <p className="mt-1.5 text-sm text-text-secondary">{template.description}</p>
                )}
                <p className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {template.requirementCount === 0
                    ? "עדיין לא הוגדרו מסמכים"
                    : `${template.requirementCount} מסמכים נדרשים`}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
