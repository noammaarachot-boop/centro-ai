import type { Metadata } from "next";
import { LogOut } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { ownerLogout } from "@/app/owner/actions";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = {
  title: "מסוף בעלים — Centro",
  description: "Centro internal owner console.",
};

// Guards every page under src/app/owner/(dashboard)/** — a sibling
// src/app/owner/login/page.tsx sits outside this route group specifically
// so requireOwnerSession() here never redirects into itself. Every Server
// Action under this tree must still independently call
// requireOwnerSession() (a layout doesn't protect the actions its pages
// invoke) — see src/lib/auth/ownerSession.ts's comment on that guard.
export default async function OwnerDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireOwnerSession();

  return (
    <div dir="rtl" className="centro-owner-shell min-h-screen">
      <header
        className="flex items-center justify-between border-b px-6 py-4"
        style={{ borderColor: "var(--owner-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: "var(--owner-accent)" }}
            aria-hidden="true"
          />
          <span className="text-sm font-bold tracking-wide" style={{ color: "var(--owner-text-primary)" }}>
            {t("owner.shell.title")}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs" style={{ color: "var(--owner-text-muted)" }}>
            {session.email}
          </span>
          <form action={ownerLogout}>
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
              style={{ borderColor: "var(--owner-border)", color: "var(--owner-text-secondary)" }}
            >
              {t("owner.shell.logout")}
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </header>
      <main className="px-6 py-8">{children}</main>
    </div>
  );
}
