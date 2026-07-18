import type { Metadata } from "next";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { logout } from "./actions";

export const metadata: Metadata = {
  title: "Centro",
  description: "Centro operational console.",
};

const NAV_LINKS = [
  { href: "/dashboard", label: "לוח בקרה" },
  { href: "/onboarding", label: "הקמת המערכת" },
  { href: "/clients", label: "לקוחות" },
  { href: "/services", label: "שירותים" },
  { href: "/collections", label: "בקשות איסוף" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {session.organizationName}
            </p>
            <p className="text-xs text-text-muted" dir="ltr">
              {session.email}
            </p>
          </div>
          <nav className="flex items-center gap-4">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-text-secondary transition-colors hover:text-brand-purple"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
          >
            <LogOut className="h-4 w-4" />
            התנתקות
          </button>
        </form>
      </header>
      <main>{children}</main>
    </div>
  );
}
