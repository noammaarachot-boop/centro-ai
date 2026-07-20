import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listClients } from "@/lib/data/clients";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";

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
        <Table>
          <TableHead>
            <TableHeadCell>שם</TableHeadCell>
            <TableHeadCell>טלפון</TableHeadCell>
            <TableHeadCell>אימייל</TableHeadCell>
          </TableHead>
          <tbody>
            {clients.map((client) => (
              <TableRow key={client.id}>
                <TableCell>
                  <Link
                    href={`/clients/${client.id}`}
                    className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                  >
                    {client.name}
                  </Link>
                </TableCell>
                <TableCell className="text-text-secondary">
                  <span dir="ltr">{client.phone}</span>
                </TableCell>
                <TableCell className="text-text-secondary">
                  <span dir="ltr">{client.email ?? "—"}</span>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
