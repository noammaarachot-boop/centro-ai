import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { needsOnboarding } from "@/lib/onboarding";
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

  // Defensive backstop for the same gate login()/register() already applied
  // via redirectAfterAuth() — e.g. a bookmarked /dashboard URL from before
  // onboarding was finished. Every (app) route shares this one check.
  const organization = await getOrganization(session.organizationId);
  if (organization && needsOnboarding(organization)) {
    redirect("/onboarding");
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        organizationName={session.organizationName}
        email={session.email}
        workflowType={organization?.workflowType ?? "recurring"}
        logoutAction={logout}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
