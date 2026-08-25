import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listPendingEmployeeReviewItems } from "@/lib/employeeReview";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { resolveReviewItem } from "./actions";

const CATEGORY_LABEL: Record<string, string> = {
  missing_document: "מסמך חסר",
  alternative_or_policy_question: "שאלת מדיניות/חלופה",
  human_request: "בקשה לדבר עם אדם",
  other: "אחר",
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { error } = await searchParams;
  const items = await listPendingEmployeeReviewItems(session.organizationId);

  return (
    <div className="mx-auto max-w-3xl animate-fade-in-up space-y-6 px-4 py-10 sm:px-6 lg:px-10">
      <Link href="/dashboard" className="mb-1 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple">
        <ArrowRight className="h-4 w-4" />
        חזרה לדשבורד
      </Link>
      <PageHeader
        title="דורש בדיקת עובד"
        description="שאלות שה-AI הבין אך אין עדיין מדיניות מאושרת שעונה עליהן — הלקוח כבר קיבל תשובה זמנית."
      />

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {items.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="אין פריטים ממתינים" description="כל השאלות שהועברו לבדיקה נענו." />
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const gist = (item.understoodContext as { gist?: string } | null)?.gist;
            return (
              <Card key={item.id} padding="md">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone="blue">{CATEGORY_LABEL[item.category] ?? item.category}</Badge>
                    <span className="text-sm font-semibold text-text-primary">{item.clientName}</span>
                  </div>
                  <span className="text-xs text-text-muted">{new Date(item.createdAt).toLocaleString("he-IL")}</span>
                </div>
                <p className="mb-1 text-sm text-text-primary">&quot;{item.clientQuestion}&quot;</p>
                {gist && <p className="mb-3 text-xs text-text-muted">הבנת ה-AI: {gist}</p>}
                {item.collectionRequestId && (
                  <Link
                    href={`/collections/${item.collectionRequestId}`}
                    className="mb-3 inline-block text-xs text-brand-blue hover:underline"
                  >
                    פתיחת הבקשה
                  </Link>
                )}

                <form action={resolveReviewItem} className="space-y-2 border-t border-border pt-3">
                  <input type="hidden" name="reviewItemId" value={item.id} />
                  <textarea
                    name="resolutionText"
                    required
                    placeholder="התשובה שתישלח ללקוח..."
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
                    rows={2}
                  />
                  <label className="flex items-center gap-2 text-xs text-text-muted">
                    <input type="checkbox" name="promoteToPolicy" />
                    לשמור את ההחלטה הזאת כמדיניות למקרים דומים בעתיד?
                  </label>
                  <button type="submit" className="rounded-lg bg-brand-purple px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90">
                    שליחת תשובה
                  </button>
                </form>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
