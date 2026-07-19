import Link from "next/link";
import { sql } from "drizzle-orm";
import { ArrowRight, CheckCircle2, Circle, Rocket } from "lucide-react";
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
  finishOnboarding,
} from "./actions";
import { ImportClientsForm } from "./ImportClientsForm";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";

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
    <div className="flex items-center justify-between rounded-xl border border-border bg-surface-muted/40 px-4 py-3.5 transition-colors hover:border-brand-purple/20">
      <div className="flex items-center gap-2.5">
        {isConnected ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-emerald" />
        ) : (
          <Circle className="h-5 w-5 shrink-0 text-text-muted" />
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
          className={buttonVariants({ variant: "secondary", size: "sm" })}
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
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        eyebrow="הקמת המערכת"
        title={
          <span className="inline-flex items-center gap-2.5">
            <Rocket className="h-6 w-6 text-brand-purple" />
            {organization.name}
          </span>
        }
        description="שלבי ההקמה עבור המשרד, לפי הסדר המומלץ."
      />

      {error === "integrations-required" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business.
        </p>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">חיבורי מערכת</h2>
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
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">ייבוא לקוחות</h2>
        <p className="mb-4 text-sm text-text-muted">
          קובץ CSV עם עמודות שם וטלפון (ואופציונלית אימייל והערות). ניתן גם להוסיף
          לקוחות אחד-אחד בעמוד{" "}
          <Link href="/clients" className="text-brand-purple hover:underline">
            הלקוחות
          </Link>
          .
        </p>
        <ImportClientsForm />
      </Card>

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">סיכום לפני הפעלה</h2>
        <dl className="grid grid-cols-3 gap-4 text-center">
          <div className="rounded-xl border border-border bg-surface-muted/40 py-4">
            <dt className="text-xs text-text-muted">לקוחות</dt>
            <dd className="mt-1 text-2xl font-bold text-text-primary">{clients.length}</dd>
          </div>
          <div className="rounded-xl border border-border bg-surface-muted/40 py-4">
            <dt className="text-xs text-text-muted">שירותים</dt>
            <dd className="mt-1 text-2xl font-bold text-text-primary">{services.length}</dd>
          </div>
          <div className="rounded-xl border border-border bg-surface-muted/40 py-4">
            <dt className="text-xs text-text-muted">שיוכים</dt>
            <dd className="mt-1 text-2xl font-bold text-text-primary">{assignmentCount}</dd>
          </div>
        </dl>
      </Card>

      <Card glow="purple">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">הפעלת אוטומציה</h2>
        <p className="mb-4 text-sm text-text-muted">
          {integrationsReady
            ? "כל החיבורים ההכרחיים מוכנים. ניתן להפעיל את האוטומציה."
            : "יש לחבר Google ו-WhatsApp Business לפני הפעלת האוטומציה."}
        </p>
        <form action={isAutomationActive ? deactivateAutomation : activateAutomation}>
          <button
            type="submit"
            disabled={!integrationsReady && !isAutomationActive}
            className={buttonVariants({ variant: "primary", size: "lg" })}
          >
            {isAutomationActive ? "השבתת אוטומציה" : "הפעלת אוטומציה"}
          </button>
        </form>
      </Card>

      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <p className="text-sm text-text-muted">
          אפשר להמשיך להגדיר את המערכת מאוחר יותר.
        </p>
        <form action={finishOnboarding}>
          <button
            type="submit"
            className={buttonVariants({ variant: "ghost" })}
          >
            המשך ללוח הבקרה
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
