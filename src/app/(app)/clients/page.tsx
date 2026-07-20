import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listClients } from "@/lib/data/clients";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";

export default async function ClientsPage() {
  const session = await requireSession();
  const clients = await listClients(session.organizationId);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="לקוחות"
        description="ניהול הלקוחות של העסק וההיסטוריה שלהם."
        actions={
          <Link href="/clients/new" className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" />
            לקוח חדש
          </Link>
        }
      />

      {clients.length === 0 ? (
        <EmptyState
          icon={Users}
          title="עדיין אין לקוחות"
          description="הוסיפו את הלקוח הראשון כדי להתחיל לאסוף מסמכים, או ייבאו רשימה שלמה דרך הקמת המערכת."
          action={
            <Link href="/clients/new" className={buttonVariants({ variant: "primary" })}>
              <Plus className="h-4 w-4" />
              הוספת לקוח ראשון
            </Link>
          }
        />
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-end text-sm">
              <thead className="sticky top-0 bg-surface-muted text-text-muted">
                <tr>
                  <th className="px-5 py-3.5 font-medium">שם</th>
                  <th className="px-5 py-3.5 font-medium">טלפון</th>
                  <th className="px-5 py-3.5 font-medium">אימייל</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr
                    key={client.id}
                    className="border-t border-border transition-colors hover:bg-surface-muted/60"
                  >
                    <td className="px-5 py-4">
                      <Link
                        href={`/clients/${client.id}`}
                        className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                      >
                        {client.name}
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-text-secondary" dir="ltr">
                      {client.phone}
                    </td>
                    <td className="px-5 py-4 text-text-secondary" dir="ltr">
                      {client.email ?? "—"}
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
