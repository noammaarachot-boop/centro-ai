import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileStack, Layers, Trash2, X } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getClient,
  listClientServices,
  listUnassignedServicesForClient,
} from "@/lib/data/clients";
import { listBusinessTypes } from "@/lib/businessTypes";
import { AUTO_CLASSIFY_CONFIDENCE } from "@/lib/ai/businessTypeClassifier";
import { listClientDocumentProfileChanges } from "@/lib/clientDocumentProfile";
import {
  assignService,
  deleteClient,
  setClientBusinessType,
  unassignService,
  updateClient,
} from "../actions";
import { ClientForm } from "../ClientForm";
import { createCollectionRequest } from "../../collections/actions";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { Button, buttonVariants } from "@/components/app/Button";
import { SelectField } from "@/components/app/FormField";
import { EmptyState } from "@/components/app/EmptyState";

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error } = await searchParams;

  const client = await getClient(session.organizationId, id);
  if (!client) notFound();

  const [assignedServices, unassignedServices, businessTypes, documentProfileChanges] = await Promise.all([
    listClientServices(session.organizationId, id),
    listUnassignedServicesForClient(session.organizationId, id),
    listBusinessTypes(session.organizationId),
    listClientDocumentProfileChanges(session.organizationId, id),
  ]);
  const currentBusinessType = businessTypes.find((t) => t.id === client.businessTypeId) ?? null;

  // Milestone 6 — plain-language label per (action, status) combination.
  // "remove" is phrased around what happened to the *document*, not the
  // literal confirmation reply, since Architecture Ch.3's exact removal
  // question ("should we continue requesting it?") has an inverted
  // yes/no meaning relative to the addition question — see
  // src/lib/clientDocumentProfile.ts's applyDocumentProfileConfirmation.
  function profileChangeLabel(change: (typeof documentProfileChanges)[number]): string {
    if (change.action === "add") {
      if (change.status === "confirmed") return `נוסף לאיסוף הקבוע: ${change.name}`;
      if (change.status === "declined") return `לא נוסף (הלקוח סירב): ${change.name}`;
      return `ממתין לאישור הוספה: ${change.name}`;
    }
    if (change.status === "confirmed") return `הוסר מהאיסוף הקבוע: ${change.name}`;
    if (change.status === "declined") return `נשאר באיסוף (הלקוח ביקש להמשיך): ${change.name}`;
    return `ממתין לאישור הסרה: ${change.name}`;
  }

  const boundUpdate = updateClient.bind(null, client.id);
  const boundDelete = deleteClient.bind(null, client.id);
  const boundAssign = assignService.bind(null, client.id);
  const boundSetBusinessType = setClientBusinessType.bind(null, client.id);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/clients"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה ללקוחות
        </Link>
        <PageHeader
          title={client.name}
          actions={
            client.learningMode ? (
              <Badge tone="purple">מצב למידה — Centro עדיין לומד את הלקוח</Badge>
            ) : undefined
          }
        />
      </div>

      {error === "has-history" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן למחוק לקוח שיש לו היסטוריית בקשות איסוף.
        </p>
      )}
      {error === "period-required" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          נא להזין תקופה לפני פתיחת בקשת איסוף.
        </p>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי לקוח</h2>
        <ClientForm
          action={boundUpdate}
          submitLabel="שמירת שינויים"
          defaultValues={{
            name: client.name,
            phone: client.phone,
            email: client.email,
            notes: client.notes,
          }}
        />
      </Card>

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">סוג עסק</h2>
        {currentBusinessType ? (
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{currentBusinessType.name}</span>
            {client.businessTypeConfidence !== null && (
              <Badge tone={client.businessTypeConfidence >= AUTO_CLASSIFY_CONFIDENCE ? "success" : "warning"}>
                {client.businessTypeConfidence >= AUTO_CLASSIFY_CONFIDENCE
                  ? "סיווג ודאי"
                  : "הצעה — כדאי לוודא"}
              </Badge>
            )}
          </div>
        ) : (
          <p className="mb-4 text-sm text-text-muted">
            Centro לא הצליח לזהות סוג עסק אוטומטית עבור לקוח זה.
          </p>
        )}

        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-brand-purple hover:underline">
            {currentBusinessType ? "שינוי סוג עסק" : "שיוך סוג עסק"}
          </summary>
          <form action={boundSetBusinessType} className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <SelectField id="businessTypeId" name="businessTypeId" label="סוג עסק קיים" optional>
                <option value="">— בחירה —</option>
                {businessTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="min-w-[200px] flex-1">
              <input
                name="newTypeName"
                type="text"
                placeholder="או: שם סוג עסק חדש"
                className="w-full rounded-xl border border-border bg-white px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
              />
            </div>
            <Button type="submit" variant="secondary">
              שיוך סוג עסק
            </Button>
          </form>
        </details>
      </Card>

      {documentProfileChanges.length > 0 && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <FileStack className="h-5 w-5 shrink-0 text-brand-purple" />
            <h2 className="text-lg font-semibold text-text-primary">פרופיל איסוף המסמכים</h2>
          </div>
          <p className="mb-4 text-xs text-text-muted">
            שינויים שהתגלו ואושרו מול הלקוח (Ch.3: Observe → Suggest → Confirm → Learn) — בנוסף
            לרשימת המסמכים הקבועה של סוג העסק.
          </p>
          <ul className="space-y-2">
            {documentProfileChanges.map((change) => (
              <li key={change.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-text-secondary">{profileChangeLabel(change)}</span>
                <Badge
                  tone={
                    change.status === "confirmed"
                      ? "success"
                      : change.status === "declined"
                        ? "neutral"
                        : "warning"
                  }
                >
                  {change.status === "confirmed" ? "פעיל" : change.status === "declined" ? "נדחה" : "ממתין"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">שירותים משויכים</h2>
        {assignedServices.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="אין שירותים משויכים"
            description="שייכו שירות ללקוח כדי לפתוח עבורו בקשות איסוף מסמכים."
          />
        ) : (
          <ul className="mb-5 space-y-3">
            {assignedServices.map((assignment) => (
              <li
                key={assignment.assignmentId}
                className="rounded-xl border border-border bg-surface-muted/40 px-4 py-3 transition-colors hover:border-brand-purple/20"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-text-primary">
                    {assignment.serviceName}
                  </span>
                  <form
                    action={unassignService.bind(
                      null,
                      client.id,
                      assignment.assignmentId
                    )}
                  >
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 text-xs font-medium text-danger transition-colors hover:underline"
                    >
                      <X className="h-3 w-3" />
                      הסרת שיוך
                    </button>
                  </form>
                </div>
                <form
                  action={createCollectionRequest.bind(
                    null,
                    client.id,
                    assignment.serviceId
                  )}
                  className="mt-2.5 flex items-center gap-2"
                >
                  <input
                    name="periodLabel"
                    type="text"
                    required
                    placeholder="תקופה, למשל 2026-07"
                    className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
                  />
                  <button
                    type="submit"
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    פתיחת בקשת איסוף
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {unassignedServices.length > 0 && (
          <form action={boundAssign} className="flex items-end gap-2">
            <div className="flex-1">
              <SelectField id="serviceId" name="serviceId" label="שיוך שירות נוסף" required>
                {unassignedServices.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button type="submit" variant="secondary">
              שיוך
            </Button>
          </form>
        )}
      </Card>

      <form action={boundDelete}>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-danger transition-colors hover:underline"
        >
          <Trash2 className="h-4 w-4" />
          מחיקת לקוח
        </button>
      </form>
    </div>
  );
}
