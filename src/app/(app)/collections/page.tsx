import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listCollectionRequests } from "@/lib/data/collectionRequests";
import { StatusBadge } from "./StatusBadge";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";

export default async function CollectionsPage() {
  const session = await requireSession();
  const collectionRequests = await listCollectionRequests(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="בקשות איסוף"
        description="כל בקשות איסוף המסמכים מכל הלקוחות, על פני כל השירותים."
      />

      {collectionRequests.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="עדיין אין בקשות איסוף"
          description="ניתן לפתוח בקשה מעמוד הלקוח, מתוך רשימת השירותים המשויכים."
        />
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-end text-sm">
              <thead className="sticky top-0 bg-surface-muted text-text-muted">
                <tr>
                  <th className="px-5 py-3.5 font-medium">לקוח</th>
                  <th className="px-5 py-3.5 font-medium">שירות</th>
                  <th className="px-5 py-3.5 font-medium">תקופה</th>
                  <th className="px-5 py-3.5 font-medium">סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {collectionRequests.map((cr) => (
                  <tr
                    key={cr.id}
                    className="border-t border-border transition-colors hover:bg-surface-muted/60"
                  >
                    <td className="px-5 py-4">
                      <Link
                        href={`/collections/${cr.id}`}
                        className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                      >
                        {cr.clientName}
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-text-secondary">{cr.serviceName}</td>
                    <td className="px-5 py-4 text-text-secondary">{cr.periodLabel}</td>
                    <td className="px-5 py-4">
                      <StatusBadge status={cr.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
