import Link from "next/link";
import { FileText, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listTemplatesWithActiveCounts } from "@/lib/data/templates";
import { deleteTemplate } from "../templates/actions";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";

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
            <Card key={template.id} interactive glow="purple" className="relative h-full">
              {/* Stretched-link pattern: the whole card opens the template
                  (z-0, fills the card); the edit/delete buttons below sit
                  above it (z-10) so they intercept their own clicks first —
                  "open" is the card's primary action, edit/delete are
                  secondary, per the approved sketch. */}
              <Link
                href={`/collections/manage/${template.id}`}
                className="absolute inset-0 z-0 rounded-2xl"
                aria-label={`פתיחת התבנית ${template.name}`}
              />
              <div className="relative z-10 flex items-start justify-between gap-3">
                <p className="pointer-events-none font-semibold text-text-primary">{template.name}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  {template.activeRequestCount > 0 && (
                    <Badge tone="blue" className="pointer-events-none">
                      {template.activeRequestCount} פעילות
                    </Badge>
                  )}
                  <Link
                    href={`/collections/manage/${template.id}`}
                    aria-label={`עריכת התבנית ${template.name}`}
                    className="grid h-6.5 w-6.5 shrink-0 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-brand-purple hover:text-brand-purple"
                  >
                    <Pencil className="h-3 w-3" aria-hidden="true" />
                  </Link>
                  <ConfirmDialog
                    title="מחיקת תבנית"
                    description={`למחוק את "${template.name}"? פעולה זו אינה הפיכה. אם לתבנית יש היסטוריית שליחות, המחיקה תיחסם.`}
                    confirmLabel="מחיקה"
                    formAction={deleteTemplate.bind(null, template.id)}
                    triggerClassName="grid h-6.5 w-6.5 shrink-0 place-items-center rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-danger hover:text-danger"
                    trigger={
                      <span aria-label={`מחיקת התבנית ${template.name}`}>
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </span>
                    }
                  />
                </div>
              </div>
              {template.description && (
                <p className="pointer-events-none relative z-10 mt-1.5 text-sm text-text-secondary">
                  {template.description}
                </p>
              )}
              <p className="pointer-events-none relative z-10 mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                {template.requirementCount === 0
                  ? "עדיין לא הוגדרו מסמכים"
                  : `${template.requirementCount} מסמכים נדרשים`}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
