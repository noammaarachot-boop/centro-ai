import { requireSession } from "@/lib/auth/session";

export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-text-primary">
        ברוכים הבאים, {session.organizationName}
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        ההתחברות הצליחה. לוח הבקרה התפעולי האמיתי (תורי עבודה, סטטוסים) ייבנה
        באבני דרך מאוחרות יותר.
      </p>
    </div>
  );
}
