import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { listCollectionRequests } from "@/lib/data/collectionRequests";
import { StatusBadge } from "./StatusBadge";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";

export default async function CollectionsPage() {
  const session = await requireSession();
  const [organization, collectionRequests] = await Promise.all([
    getOrganization(session.organizationId),
    listCollectionRequests(session.organizationId),
  ]);
  const isOneTime = organization?.workflowType === "one_time";
  const serviceWord = isOneTime ? "תבנית" : "שירות";
  const servicesWord = isOneTime ? "התבניות" : "השירותים";

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="בקשות איסוף"
        description={`כל בקשות איסוף המסמכים מכל הלקוחות, על פני כל ${servicesWord}.`}
      />

      {collectionRequests.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="עדיין אין בקשות איסוף"
          description={`ניתן לפתוח בקשה מעמוד הלקוח, מתוך רשימת ${isOneTime ? "התבניות המשויכות" : "השירותים המשויכים"}.`}
        />
      ) : (
        <Table minWidth={560}>
          <TableHead>
            <TableHeadCell>לקוח</TableHeadCell>
            <TableHeadCell>{serviceWord}</TableHeadCell>
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
