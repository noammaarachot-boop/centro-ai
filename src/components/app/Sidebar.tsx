"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import {
  LayoutDashboard,
  Users,
  Layers,
  LayoutTemplate,
  FolderKanban,
  ScrollText,
  Settings,
  LogOut,
  ChevronsRight,
  ChevronsLeft,
} from "lucide-react";
import { CentroMark } from "@/components/landing/icons/CentroMark";

const RECURRING_NAV_LINKS = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/clients", label: "לקוחות", icon: Users },
  { href: "/services", label: "תבניות", icon: Layers },
  { href: "/collections", label: "בקשות איסוף", icon: FolderKanban },
  { href: "/audit", label: "פעילות", icon: ScrollText },
  { href: "/settings", label: "הגדרות", icon: Settings },
];

// Product Evolution M4 — Workflow B's own, smaller nav: Templates replaces
// Services/Collections as the primary surface (a Template *is* a bare
// Service under the hood, and sending one creates real Collection
// Requests — see ARCHITECTURE.md — so nothing is lost by not linking those
// routes directly, just decluttered). The underlying routes still work if
// visited directly; only the nav itself is workflow-specific.
const ONE_TIME_NAV_LINKS = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/clients", label: "לקוחות", icon: Users },
  { href: "/templates", label: "תבניות", icon: LayoutTemplate },
  { href: "/audit", label: "פעילות", icon: ScrollText },
  { href: "/settings", label: "הגדרות", icon: Settings },
];

export function Sidebar({
  organizationName,
  email,
  logoUrl,
  workflowType,
  logoutAction,
}: {
  organizationName: string;
  email: string;
  logoUrl?: string | null;
  workflowType: "recurring" | "one_time";
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const NAV_LINKS = workflowType === "one_time" ? ONE_TIME_NAV_LINKS : RECURRING_NAV_LINKS;

  return (
    <aside
      className={clsx(
        "sticky top-0 flex h-screen shrink-0 flex-col border-e border-border bg-surface/80 backdrop-blur-xl transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "w-[76px]" : "w-64"
      )}
    >
      <div className="flex items-center gap-2.5 px-5 py-5">
        <CentroMark
          className="h-8 w-8 shrink-0 drop-shadow-[0_2px_10px_rgba(124,58,237,0.35)]"
          title="Centro"
        />
        {!collapsed && (
          <span className="animate-fade-in-up truncate text-base font-bold text-text-primary">
            Centro
          </span>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV_LINKS.map((link) => {
          const active =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                active
                  ? "bg-gradient-to-l from-brand-purple/10 to-brand-blue/5 text-brand-purple"
                  : "text-text-secondary hover:bg-surface-muted hover:text-text-primary"
              )}
              title={collapsed ? link.label : undefined}
            >
              {active && (
                <span className="absolute inset-y-1 end-0 w-0.5 rounded-full bg-gradient-to-b from-brand-purple to-brand-blue" />
              )}
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
        >
          {collapsed ? (
            <ChevronsLeft className="h-4 w-4" />
          ) : (
            <>
              <ChevronsRight className="h-4 w-4" />
              צמצום תפריט
            </>
          )}
        </button>

        {!collapsed && (
          <div className="mb-2 flex items-center gap-2.5 rounded-xl bg-surface-muted px-3 py-2.5">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded-lg object-cover"
              />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text-primary">
                {organizationName}
              </p>
              <p className="truncate text-xs text-text-muted" dir="ltr">
                {email}
              </p>
            </div>
          </div>
        )}

        <form action={logoutAction}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-danger/5 hover:text-danger"
            title={collapsed ? "התנתקות" : undefined}
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            {!collapsed && "התנתקות"}
          </button>
        </form>
      </div>
    </aside>
  );
}
