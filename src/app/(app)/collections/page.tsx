import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listCollectionRequests } from "@/lib/data/collectionRequests";
import { StatusBadge } from "./StatusBadge";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { buttonVariants } from "@/components/app/Button";

// Product Evolution M9 — an organization can have both Recurring
// Collections and On-Demand Templates producing requests here at once, so
// this page (and its wording) is deliberately mode-neutral rather than
// picking one word based on the organization's onboarding choice.
//
// First-Send Journey — this page is also now the on-demand path's front
// door: "+ New" opens the Collection Requests wizard (/collections/new),
// which replaces the retired /templates list. Recurring requests (opened
// automatically by src/lib/recurringScheduler.ts) still land in this same
// list unchanged — this page's own content stays mode-neutral, only a
// creation entry point was added.
export default async function CollectionsPage() {
  const session = await requireSession();
  const collectionRequests = await listCollectionRequests(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="בקשות איסוף"
        description="כל בקשות איסוף המסמכים מכל הלקוחות, מאיסוף מחזורי ומאיסוף לפי צורך כאחד."
        actions={
          <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus className="h-4 w-4" />
            בקשת איסוף חדשה
          </Link>
        }
      />

      {collectionRequests.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="עדיין אין בקשות איסוף"
          description="צרו בקשת איסוף כדי לשלוח בקשה לקוח ראשון, או המתינו למחזור האיסוף הבא."
          action={
            <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              יצירת בקשת איסוף
            </Link>
          }
        />
      ) : (
        <Table minWidth={560}>
          <TableHead>
            <TableHeadCell>לקוח</TableHeadCell>
            <TableHeadCell>איסוף</TableHeadCell>
            <TableHeadCell>תקופה</TableHeadCell>
            <TableHeadCell>סטטוס</TableHeadCell>
          </TableHead>
          <tbody>
            {collectionRequests.map((cr) => (
              <TableRow key={cr.id}>
                <TableCell>
                  <Link
                    href={`/collections/${cr.id}`}
                    className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                  >
                    {cr.clientName}
                  </Link>
                </TableCell>
                <TableCell className="text-text-secondary">{cr.serviceName}</TableCell>
                <TableCell className="text-text-secondary">{cr.periodLabel}</TableCell>
                <TableCell>
                  <StatusBadge status={cr.status} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
