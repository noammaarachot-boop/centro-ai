import Link from "next/link";
import { ArrowLeft, ScrollText } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { listAuditLog } from "@/lib/data/auditLog";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { Badge } from "@/components/app/Badge";

const ACTOR_LABELS: Record<string, string> = {
  employee: "עובד",
  ai: "AI",
  client: "לקוח",
  system: "מערכת",
};

export default async function AuditLogPage() {
  const session = await requireSession();
  const events = await listAuditLog(session.organizationId);

  return (
    <div className="mx-auto max-w-4xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        title="פעילות"
        description="רשומות בלתי ניתנות לעריכה של כל האירועים המשמעותיים במערכת (Ch.17). מוצגות 200 הרשומות האחרונות."
      />

      {events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="אין עדיין רשומות ביקורת"
          description="כל פעולה משמעותית במערכת תתועד כאן."
        />
      ) : (
        <ul className="space-y-2.5">
          {events.map((event) => (
            <li key={event.id}>
              <Card padding="sm">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm text-text-primary">{event.description}</p>
                  <span className="shrink-0 text-xs text-text-muted">
                    {new Date(event.occurredAt).toLocaleString("he-IL")}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <Badge tone="neutral">
                    {ACTOR_LABELS[event.actorType] ?? event.actorType}
                    {event.actorEmail ? ` · ${event.actorEmail}` : ""}
                  </Badge>
                  <span>{event.eventType}</span>
                  {event.clientName && (
                    <span>
                      · <span className="text-text-secondary">{event.clientName}</span>
                    </span>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה ללוח הבקרה
        </Link>
      </p>
    </div>
  );
}
