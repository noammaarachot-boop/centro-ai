import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listCollectionRequests } from "@/lib/data/collectionRequests";
import { StatusBadge } from "./StatusBadge";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";

// Product Evolution M9 — an organization can have both Recurring
// Collections and On-Demand Templates producing requests here at once, so
// this page (and its wording) is deliberately mode-neutral rather than
// picking one word based on the organization's onboarding choice.
export default async function CollectionsPage() {
  const session = await requireSession();
  const collectionRequests = await listCollectionRequests(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="בקשות איסוף"
        description="כל בקשות איסוף המסמכים מכל הלקוחות, מאיסוף מחזורי ומאיסוף לפי צורך כאחד."
      />

      {collectionRequests.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="עדיין אין בקשות איסוף"
          description="ניתן לפתוח בקשה מעמוד הלקוח, מתוך רשימת האיסופים המשויכים."
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
