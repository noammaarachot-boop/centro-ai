import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { listCollectionRequests } from "@/lib/data/collectionRequests";
import { StatusBadge } from "./StatusBadge";

export default async function CollectionsPage() {
  const session = await requireSession();
  const collectionRequests = await listCollectionRequests(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">
        בקשות איסוף
      </h1>

      {collectionRequests.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface-muted px-6 py-10 text-center text-sm text-text-muted">
          עדיין אין בקשות איסוף. ניתן לפתוח בקשה מעמוד הלקוח, מתוך רשימת
          השירותים המשויכים.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          <table className="w-full text-end text-sm">
            <thead className="bg-surface-muted text-text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">לקוח</th>
                <th className="px-4 py-3 font-medium">שירות</th>
                <th className="px-4 py-3 font-medium">תקופה</th>
                <th className="px-4 py-3 font-medium">סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {collectionRequests.map((cr) => (
                <tr key={cr.id} className="border-t border-border hover:bg-surface-muted">
                  <td className="px-4 py-3">
                    <Link
                      href={`/collections/${cr.id}`}
                      className="font-medium text-text-primary hover:text-brand-purple"
                    >
                      {cr.clientName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{cr.serviceName}</td>
                  <td className="px-4 py-3 text-text-secondary">{cr.periodLabel}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={cr.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
