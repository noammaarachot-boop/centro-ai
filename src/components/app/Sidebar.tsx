"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import {
  LayoutDashboard,
  Users,
  Layers,
  FolderKanban,
  ScrollText,
  Settings,
  LogOut,
  ChevronsRight,
  ChevronsLeft,
  Menu,
  X,
  Sparkles,
  LifeBuoy,
} from "lucide-react";
import { CentroMark } from "@/components/landing/icons/CentroMark";

// "עוזר AI" is hidden (not rendered) rather than removed — every route,
// API, and component behind it is untouched, this only stops the nav
// item itself from rendering. Restore by deleting the `hidden: true` line.
// "תמיכה" used to be a plain external WhatsApp deep-link (<a target=
// "_blank">, the `external` branch below). It's now a real internal page
// (/support) with an in-app support-request form — WhatsApp is still
// offered there, just as a secondary contact option, not the only path.
//
// Product Evolution M9 — a single nav for every organization, regardless
// of which collection mode it started onboarding with. "שירותים" stays its
// own permanent, always-visible link for Recurring Services — untouched by
// the First-Send Journey rework below.
//
// First-Send Journey — "תבניות" (On-Demand Templates, /templates) is
// retired: its create/manage functionality now lives inside "בקשות איסוף"
// itself (/collections — see that page's own "+ New" entry point and
// /collections/new), so a separate nav link for it would just duplicate
// this one. Recurring's own nav entry and terminology are deliberately
// untouched — this only changes the on-demand side.
//
// Template gallery rework — "איסוף מחזורי" (/services) hidden the same way
// "עוזר AI" already is: the org's own choice right now is to focus the
// visible UI entirely on on-demand templates. Nothing about the recurring
// engine, its routes, or its data changed — /services, /services/new,
// /services/[id] and recurringScheduler.ts are all fully intact, just
// unlinked from nav. Delete this one `hidden: true` line to bring it back.
const NAV_LINKS = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/assistant", label: "עוזר AI", icon: Sparkles, hidden: true },
  { href: "/clients", label: "לקוחות", icon: Users },
  { href: "/services", label: "איסוף מחזורי", icon: Layers, hidden: true },
  { href: "/collections", label: "בקשות איסוף", icon: FolderKanban },
  { href: "/audit", label: "היסטוריית פעילות", icon: ScrollText },
  { href: "/settings", label: "הגדרות", icon: Settings },
  { href: "/support", label: "תמיכה", icon: LifeBuoy },
];

export function Sidebar({
  organizationName,
  email,
  logoUrl,
  logoutAction,
}: {
  organizationName: string;
  email: string;
  logoUrl?: string | null;
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navContent = (
    <>
      <div className="flex items-center justify-between gap-2.5 px-5 py-5">
        <div className="flex items-center gap-2.5">
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
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="סגירת תפריט"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-secondary hover:bg-surface-muted lg:hidden"
        >
          <X className="h-4.5 w-4.5" />
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV_LINKS.filter((link) => !("hidden" in link && link.hidden)).map((link) => {
          const active =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          const Icon = link.icon;
          const linkClassName = clsx(
            "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ease-[var(--ease-standard)]",
            active
              ? "bg-gradient-to-l from-brand-purple/10 to-brand-blue/5 text-brand-purple"
              : "text-text-secondary hover:bg-surface-muted hover:text-text-primary"
          );

          if ("external" in link && link.external) {
            return (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
                title={collapsed ? link.label : undefined}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                {!collapsed && <span className="truncate">{link.label}</span>}
              </a>
            );
          }

          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className={linkClassName}
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
          className="mb-2 hidden w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary lg:flex"
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
    </>
  );

  return (
    <>
      {/* Mobile top bar — the sidebar itself is a hidden-by-default fixed
          drawer below the lg breakpoint, so this is the only persistent
          chrome/brand presence and the trigger to open it. Previously
          there was no mobile handling at all: the sidebar was a fixed
          w-64/w-[76px] column regardless of viewport. */}
      <div className="centro-glass-strong sticky top-0 z-30 flex items-center justify-between border-b border-border px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="פתיחת תפריט"
          className="grid h-9 w-9 place-items-center rounded-lg text-text-secondary transition-colors hover:bg-surface-muted"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-text-primary">Centro</span>
          <CentroMark className="h-6 w-6" title="Centro" />
        </div>
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 animate-fade-in-up bg-text-primary/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={clsx(
          // Physical `right-0` rather than the logical `end-0` — this
          // sidebar visually sits on the right in this RTL app either way,
          // and `end-0` doesn't resolve correctly for a `fixed`-positioned
          // element the way it does for a normal-flow one (confirmed via
          // computed-style inspection: it fell back to left-anchored
          // positioning instead), so the physical property is the correct,
          // unambiguous choice here specifically.
          "centro-glass-strong fixed inset-y-0 right-0 z-50 flex h-screen w-72 max-w-[85vw] flex-col border-s border-border transition-transform duration-300 ease-[var(--ease-standard)]",
          // Parked off-screen with a transform when closed, which is what
          // makes the open/close slide an animation at all — `hidden` would
          // make it appear and vanish instantly. Safe for page width: this
          // panel is `position: fixed`, and a fixed element is positioned
          // against the viewport, so it never enters the document's
          // scrollable overflow region no matter how far it is translated.
          // (Measured: the page overflow this was once blamed for is
          // unchanged with the sidebar hidden — see .centro-live-card.)
          mobileOpen ? "translate-x-0" : "translate-x-full",
          "lg:sticky lg:top-0 lg:z-auto lg:w-64 lg:translate-x-0 lg:border-s-0 lg:border-e lg:transition-[width]",
          collapsed && "lg:w-[76px]"
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
