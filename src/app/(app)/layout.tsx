import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/session";
import { Sidebar } from "@/components/app/Sidebar";
import { logout } from "./actions";

export const metadata: Metadata = {
  title: "Centro",
  description: "Centro operational console.",
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        organizationName={session.organizationName}
        email={session.email}
        logoutAction={logout}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
