import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { needsOnboarding } from "@/lib/onboarding";
import { listClients } from "@/lib/data/clients";
import { getBusinessCategoryIcon, getBusinessCategoryLabel } from "@/lib/businessCategories";
import { WizardShell } from "./WizardShell";
import { Step1Welcome } from "./steps/Step1Welcome";
import { Step2OfficeInfo } from "./steps/Step2OfficeInfo";
import { Step3BusinessType } from "./steps/Step3BusinessType";
import { Step6OneTimeImport } from "./steps/Step6OneTimeImport";

export const metadata: Metadata = {
  title: "הקמת המערכת — Centro",
};

type StepMeta = { title: string; description?: string; help?: string };

// First-Send Journey — onboarding is now a single, unbranched 4-step flow
// for every new organization: Welcome, Business Details, Business Type,
// Import Clients, then straight to the Dashboard. There is no longer a
// "Collection Style" choice screen (Recurring vs. On-Demand vs. Both) —
// every new signup starts on-demand (`registration` sets
// `organizations.workflowType = "on_demand"` directly, see login/actions.ts)
// and WhatsApp/Drive connect for the first time inside the Collection
// Requests wizard's own Connect step, in-context, right before the first
// send — not during onboarding at all anymore.
//
// The older, longer recurring-workflow onboarding (Connect, Import,
// Analysis, Documents, Reminders, Summary, Completion — Chapters 9-11) and
// the Collection Style picker itself still exist in this directory's step
// components and actions, unused by this page. They're not deleted:
// an organization that already completed that flow in the past is gated
// out of onboarding entirely by `needsOnboarding` below and never touches
// any of this again, and removing the code outright — rather than simply
// not routing to it — felt like a bigger, more one-way decision than "give
// new users a single journey" asked for. Flag if that call was wrong.
const STEP_META: Record<number, StepMeta> = {
  1: { title: "ברוכים הבאים ל-Centro" },
  2: {
    title: "פרטי העסק",
    description: "כמה פרטים בסיסיים כדי להתאים את Centro לעסק שלכם.",
    help: "המידע הזה משמש להתאמה אישית של סביבת העבודה שלכם. תמיד ניתן לשנות זאת מאוחר יותר מתוך ההגדרות.",
  },
  3: {
    title: "תחום הפעילות שלכם",
    description: "מה תחום הפעילות שלכם? Centro משתמש בכך כדי להציע לכם מראש רשימת התחלה מתאימה — לא את אותה רשימה לכולם.",
    help: "זה תחום הפעילות של המשרד שלכם עצמו (למשל רואה חשבון, יועץ משכנתאות) — לא סוג הלקוחות שלכם, שאותו נגדיר בהמשך. גם אם מעולם לא נתקלנו בתחום שלכם, Centro תמיד יציע נקודת התחלה שימושית שאפשר לערוך באופן מלא.",
  },
  4: {
    title: "ייבוא לקוחות (אופציונלי)",
    description: "אפשר לייבא כבר עכשיו רשימת לקוחות, או לדלג ולהוסיף מאוחר יותר.",
    help: "רק שם וטלפון נשמרים בשלב הזה. ייבוא הוא תמיד אופציונלי — אפשר גם להוסיף את הלקוח הראשון ישירות מתוך יצירת בקשת האיסוף הראשונה.",
  },
};

const TOTAL_STEPS = 4;

function clampStep(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(Math.max(value, 1), TOTAL_STEPS);
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const session = await requireSession();
  const { step: stepParam } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  if (!needsOnboarding(organization)) {
    redirect("/dashboard");
  }

  const step = clampStep(Number(stepParam ?? organization.onboardingStep ?? 1) || 1);
  const meta = STEP_META[step];
  const stepTitles = [1, 2, 3, 4].map((s) => STEP_META[s].title);

  let body: React.ReactNode;
  switch (step) {
    case 1: {
      body = <Step1Welcome displayName={session.fullName || organization.name} />;
      break;
    }
    case 2: {
      body = <Step2OfficeInfo name={organization.name} logoUrl={organization.logoUrl} />;
      break;
    }
    case 3: {
      body = (
        <Step3BusinessType
          businessCategory={organization.businessCategory}
          businessCategoryCustomLabel={organization.businessCategoryCustomLabel}
        />
      );
      break;
    }
    case 4: {
      const clientList = await listClients(session.organizationId);
      body = <Step6OneTimeImport totalClients={clientList.length} />;
      break;
    }
  }

  // Item 6 — visible on the last step only (where a profession-aware
  // import experience benefits from the reminder of which profession is
  // being set up).
  const businessCategoryLabel =
    step >= 4
      ? getBusinessCategoryLabel(organization.businessCategory, organization.businessCategoryCustomLabel)
      : undefined;
  const businessCategoryIcon = step >= 4 ? getBusinessCategoryIcon(organization.businessCategory) : undefined;

  return (
    <WizardShell
      step={step}
      totalSteps={TOTAL_STEPS}
      stepTitle={stepTitles[step - 1]}
      title={meta.title}
      description={meta.description}
      help={meta.help}
      hidePrevious={step === 1}
      businessCategoryLabel={businessCategoryLabel}
      businessCategoryIcon={businessCategoryIcon}
    >
      {body}
    </WizardShell>
  );
}
