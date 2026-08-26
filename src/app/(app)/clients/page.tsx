import Link from "next/link";
import { Archive, Plus, Search, Users } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { countArchivedClients, listClients } from "@/lib/data/clients";
import { PageHeader } from "@/components/app/PageHeader";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { Badge } from "@/components/app/Badge";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const session = await requireSession();
  const { q, view } = await searchParams;
  const search = q?.trim() || undefined;
  const archivedOnly = view === "archived";

  const clients = await listClients(session.organizationId, { search, archivedOnly });
  const archivedCount = await countArchivedClients(session.organizationId);
  const isFiltered = Boolean(search);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-4 py-10 sm:px-6 lg:px-10">
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

      {/* A plain GET form, so a search is a real URL: shareable, bookmarkable,
          and correct through refresh and the back button. */}
      <form action="/clients" method="GET" className="mb-5 flex flex-wrap items-center gap-2">
        {archivedOnly && <input type="hidden" name="view" value="archived" />}
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            name="q"
            type="search"
            defaultValue={search ?? ""}
            placeholder="חיפוש לפי שם, טלפון או אימייל..."
            aria-label="חיפוש לקוחות"
            className="centro-glass h-11 w-full rounded-xl border border-border ps-10 pe-4 text-sm text-text-primary shadow-card outline-none transition-all duration-200 placeholder:text-text-muted focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
        </div>
        <button type="submit" className={buttonVariants({ variant: "secondary" })}>
          חיפוש
        </button>
        {isFiltered && (
          <Link
            href={archivedOnly ? "/clients?view=archived" : "/clients"}
            className="text-sm font-medium text-text-muted transition-colors hover:text-brand-purple"
          >
            ניקוי
          </Link>
        )}
      </form>

      {(archivedCount > 0 || archivedOnly) && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Link
            href={search ? `/clients?q=${encodeURIComponent(search)}` : "/clients"}
            className={
              archivedOnly
                ? "rounded-full border border-border px-3 py-1 text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
                : "rounded-full border border-brand-purple bg-brand-purple/10 px-3 py-1 font-medium text-brand-purple"
            }
          >
            פעילים
          </Link>
          <Link
            href={search ? `/clients?view=archived&q=${encodeURIComponent(search)}` : "/clients?view=archived"}
            className={
              archivedOnly
                ? "inline-flex items-center gap-1.5 rounded-full border border-brand-purple bg-brand-purple/10 px-3 py-1 font-medium text-brand-purple"
                : "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
            }
          >
            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
            ארכיון ({archivedCount})
          </Link>
        </div>
      )}

      {clients.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon={Search}
            title="לא נמצאו לקוחות תואמים"
            description={`אין לקוח ${archivedOnly ? "בארכיון " : ""}שתואם לחיפוש "${search}". אפשר לחפש גם לפי טלפון בכל פורמט.`}
            action={
              <Link
                href={archivedOnly ? "/clients?view=archived" : "/clients"}
                className={buttonVariants({ variant: "secondary" })}
              >
                ניקוי החיפוש
              </Link>
            }
          />
        ) : archivedOnly ? (
          <EmptyState icon={Archive} title="הארכיון ריק" description="לקוחות שתעבירו לארכיון יופיעו כאן, עם כל ההיסטוריה שלהם." />
        ) : (
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
        )
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
                  {client.archivedAt && (
                    <Badge tone="neutral" className="ms-2">
                      בארכיון
                    </Badge>
                  )}
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
