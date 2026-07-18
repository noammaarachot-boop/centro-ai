import Link from "next/link";
import { sql } from "drizzle-orm";
import { CheckCircle2, Circle } from "lucide-react";
import { getDb } from "@/db";
import { clientServices } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { listClients } from "@/lib/data/clients";
import { listServices } from "@/lib/data/services";
import {
  activateAutomation,
  connectGoogle,
  connectWhatsapp,
  deactivateAutomation,
  disconnectGoogle,
  disconnectWhatsapp,
} from "./actions";
import { ImportClientsForm } from "./ImportClientsForm";

function StatusRow({
  label,
  connectedAt,
  connectAction,
  disconnectAction,
}: {
  label: string;
  connectedAt: Date | null;
  connectAction: () => Promise<void>;
  disconnectAction: () => Promise<void>;
}) {
  const isConnected = !!connectedAt;
  return (
    <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {isConnected ? (
          <CheckCircle2 className="h-5 w-5 text-brand-emerald" />
        ) : (
          <Circle className="h-5 w-5 text-text-muted" />
        )}
        <div>
          <p className="text-sm font-medium text-text-primary">{label}</p>
          {isConnected && (
            <p className="text-xs text-text-muted">
              חובר ב-{connectedAt!.toLocaleDateString("he-IL")}
            </p>
          )}
        </div>
      </div>
      <form action={isConnected ? disconnectAction : connectAction}>
        <button
          type="submit"
          className="rounded-full border border-border px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
        >
          {isConnected ? "ניתוק" : "חיבור"}
        </button>
      </form>
    </div>
  );
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { error } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  const clients = await listClients(session.organizationId);
  const services = await listServices(session.organizationId);

  const db = await getDb();
  const [{ count: assignmentCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clientServices);

  if (!organization) return null;

  const integrationsReady =
    !!organization.googleConnectedAt && !!organization.whatsappConnectedAt;
  const isAutomationActive = !!organization.automationActivatedAt;

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          הקמת המערכת
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          שלבי ההקמה עבור {organization.name}, לפי הסדר המומלץ.
        </p>
      </div>

      {error === "integrations-required" && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business.
        </p>
      )}

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          חיבורי מערכת
        </h2>
        <div className="space-y-3">
          <StatusRow
            label="חשבון Google (Drive)"
            connectedAt={organization.googleConnectedAt}
            connectAction={connectGoogle}
            disconnectAction={disconnectGoogle}
          />
          <StatusRow
            label="WhatsApp Business"
            connectedAt={organization.whatsappConnectedAt}
            connectAction={connectWhatsapp}
            disconnectAction={disconnectWhatsapp}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          ייבוא לקוחות
        </h2>
        <p className="mb-4 text-sm text-text-muted">
          קובץ CSV עם עמודות שם וטלפון (ואופציונלית אימייל והערות). ניתן גם
          להוסיף לקוחות אחד-אחד בעמוד{" "}
          <Link href="/clients" className="text-brand-purple hover:underline">
            הלקוחות
          </Link>
          .
        </p>
        <ImportClientsForm />
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          סיכום לפני הפעלה
        </h2>
        <dl className="grid grid-cols-3 gap-4 text-center">
          <div>
            <dt className="text-xs text-text-muted">לקוחות</dt>
            <dd className="text-xl font-semibold text-text-primary">
              {clients.length}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">שירותים</dt>
            <dd className="text-xl font-semibold text-text-primary">
              {services.length}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">שיוכים</dt>
            <dd className="text-xl font-semibold text-text-primary">
              {assignmentCount}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          הפעלת אוטומציה
        </h2>
        <p className="mb-4 text-sm text-text-muted">
          {integrationsReady
            ? "כל החיבורים ההכרחיים מוכנים. ניתן להפעיל את האוטומציה."
            : "יש לחבר Google ו-WhatsApp Business לפני הפעלת האוטומציה."}
        </p>
        <form action={isAutomationActive ? deactivateAutomation : activateAutomation}>
          <button
            type="submit"
            disabled={!integrationsReady && !isAutomationActive}
            className="flex items-center justify-center gap-2 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-3 text-sm font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAutomationActive ? "השבתת אוטומציה" : "הפעלת אוטומציה"}
          </button>
        </form>
      </section>
    </div>
  );
}
