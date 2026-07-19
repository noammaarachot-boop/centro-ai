import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { listAuditLog } from "@/lib/data/auditLog";

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
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-1 text-2xl font-semibold text-text-primary">
        יומן ביקורת
      </h1>
      <p className="mb-6 text-sm text-text-secondary">
        רשומות בלתי ניתנות לעריכה של כל האירועים המשמעותיים במערכת (Ch.17).
        {" "}מוצגות 200 הרשומות האחרונות.
      </p>

      {events.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface-muted px-6 py-10 text-center text-sm text-text-muted">
          אין עדיין רשומות ביקורת.
        </p>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-xl border border-border bg-surface p-4 shadow-card"
            >
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm text-text-primary">{event.description}</p>
                <span className="shrink-0 text-xs text-text-muted">
                  {new Date(event.occurredAt).toLocaleString("he-IL")}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs text-text-muted">
                <span className="rounded-full bg-surface-muted px-2 py-0.5">
                  {ACTOR_LABELS[event.actorType] ?? event.actorType}
                  {event.actorEmail ? ` · ${event.actorEmail}` : ""}
                </span>
                <span>{event.eventType}</span>
                {event.clientName && (
                  <span>
                    ·{" "}
                    <span className="text-text-secondary">{event.clientName}</span>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-center">
        <Link href="/dashboard" className="text-sm text-text-muted hover:text-brand-purple">
          חזרה ללוח הבקרה
        </Link>
      </p>
    </div>
  );
}
