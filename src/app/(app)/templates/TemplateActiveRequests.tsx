import Link from "next/link";
import { Users } from "lucide-react";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { StatusBadge } from "../collections/StatusBadge";
import type { ActiveTemplateRequest } from "@/lib/data/templates";

// "Click a template, see its active requests" — every field here comes
// straight from listActiveRequestsForTemplate (src/lib/data/templates.ts),
// which itself only reads real collectionRequests/clients rows and calls
// computeRequirementsProgress, the same completion algorithm
// checkCompletionGate uses. No progress/status is computed in this
// component.
export function TemplateActiveRequests({ requests }: { requests: ActiveTemplateRequest[] }) {
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold text-text-primary">בקשות פעילות מהתבנית הזו</h2>
      <p className="mb-4 text-sm text-text-muted">
        כל בקשה שנוצרה מהתבנית ועדיין לא הושלמה או בוטלה.
      </p>

      {requests.length === 0 ? (
        <EmptyState icon={Users} title="אין כרגע בקשות פעילות" description="ברגע שתשלחו את התבנית ללקוח, היא תופיע כאן." />
      ) : (
        <ul className="space-y-2">
          {requests.map((request) => (
            <li key={request.collectionRequestId}>
              <Link
                href={`/collections/${request.collectionRequestId}`}
                className="block rounded-xl border border-border bg-surface-muted/40 px-4 py-3 transition-colors hover:border-brand-purple/25"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">{request.clientName}</p>
                  <StatusBadge status={request.status} hasOpenAttention={request.hasOpenAttention} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                  <span className="tabular-nums">
                    {request.satisfiedCount}/{request.totalCount} מסמכים התקבלו
                  </span>
                  {request.missingRequirementNames.length > 0 && (
                    <span className="text-text-secondary">חסר: {request.missingRequirementNames.join(", ")}</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
