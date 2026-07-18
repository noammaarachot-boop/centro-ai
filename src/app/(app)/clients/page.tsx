import Link from "next/link";
import { Plus } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listClients } from "@/lib/data/clients";

export default async function ClientsPage() {
  const session = await requireSession();
  const clients = await listClients(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">לקוחות</h1>
        <Link
          href="/clients/new"
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-4 py-2.5 text-sm font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          לקוח חדש
        </Link>
      </div>

      {clients.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface-muted px-6 py-10 text-center text-sm text-text-muted">
          עדיין אין לקוחות. הוסיפו את הלקוח הראשון כדי להתחיל.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          <table className="w-full text-end text-sm">
            <thead className="bg-surface-muted text-text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">שם</th>
                <th className="px-4 py-3 font-medium">טלפון</th>
                <th className="px-4 py-3 font-medium">אימייל</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className="border-t border-border last:rounded-b-2xl hover:bg-surface-muted"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/clients/${client.id}`}
                      className="font-medium text-text-primary hover:text-brand-purple"
                    >
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-text-secondary" dir="ltr">
                    {client.phone}
                  </td>
                  <td className="px-4 py-3 text-text-secondary" dir="ltr">
                    {client.email ?? "—"}
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
