import type { Metadata } from "next";
import Link from "next/link";
import { LogOut, Search, LayoutGrid, Building2, DollarSign } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { ownerLogout } from "@/app/owner/actions";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = {
  title: "מסוף בעלים — Centro",
  description: "Centro internal owner console.",
};

const NAV_LINKS = [
  { href: "/owner", label: "owner.nav.home" as const, icon: LayoutGrid },
  { href: "/owner/organizations", label: "owner.nav.organizations" as const, icon: Building2 },
  { href: "/owner/costs", label: "owner.nav.costs" as const, icon: DollarSign },
];

// Guards every page under src/app/owner/(dashboard)/** — a sibling
// src/app/owner/login/page.tsx sits outside this route group specifically
// so requireOwnerSession() here never redirects into itself. Every Server
// Action under this tree must still independently call
// requireOwnerSession() (a layout doesn't protect the actions its pages
// invoke) — see src/lib/auth/ownerSession.ts's comment on that guard.
//
// The header is deliberately its own hand-written dark chrome
// (.centro-owner-header, globals.css) rather than the shared design
// tokens — see that file's comment for why a scoped token override
// doesn't work with Tailwind v4's @theme inline. Page content below the
// header reuses Card/KpiCard/Table/Badge/EmptyState/PageHeader/
// FormField exactly as designed, in their normal (light) styling.
export default async function OwnerDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireOwnerSession();

  return (
    <div dir="rtl" className="centro-owner-shell min-h-screen bg-background">
      <header className="centro-owner-header">
        <div className="flex flex-wrap items-center gap-4 px-4 py-4 sm:px-6">
          <Link href="/owner" className="flex shrink-0 items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--owner-accent)" }}
              aria-hidden="true"
            />
            <span className="text-sm font-bold tracking-wide">{t("owner.shell.title")}</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {NAV_LINKS.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors hover:bg-white/5"
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(label)}
              </Link>
            ))}
          </nav>

          <form
            action="/owner/organizations"
            method="GET"
            className="order-last flex min-w-0 flex-1 basis-full items-center gap-2 sm:order-none sm:basis-auto"
          >
            <div className="relative min-w-0 flex-1 sm:w-64">
              <Search
                className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted"
                aria-hidden="true"
              />
              <input
                type="search"
                name="q"
                placeholder={t("owner.search.placeholder")}
                aria-label={t("owner.search.placeholder")}
                className="w-full rounded-full border border-border bg-surface py-2 ps-9 pe-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
              />
            </div>
          </form>

          <div className="ms-auto flex shrink-0 items-center gap-3">
            <span className="hidden text-xs sm:inline">{session.email}</span>
            <form action={ownerLogout}>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              >
                {t("owner.shell.logout")}
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
