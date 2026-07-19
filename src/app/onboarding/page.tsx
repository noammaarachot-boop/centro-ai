import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { listClients } from "@/lib/data/clients";
import { listServiceRequirements, getService } from "@/lib/data/services";
import {
  getSuggestedRequirements,
  listBusinessTypes,
  listClientsByBusinessType,
  listUnclassifiedClients,
} from "@/lib/businessTypes";
import { WizardShell, TOTAL_STEPS } from "./WizardShell";
import { Step1Welcome } from "./steps/Step1Welcome";
import { Step2OfficeInfo } from "./steps/Step2OfficeInfo";
import { Step3Connect } from "./steps/Step3Connect";
import { Step4Import } from "./steps/Step4Import";
import { Step5Analysis } from "./steps/Step5Analysis";
import { Step6Documents } from "./steps/Step6Documents";
import { Step7Reminders } from "./steps/Step7Reminders";
import { Step8Summary } from "./steps/Step8Summary";
import { Step9Completion } from "./steps/Step9Completion";

export const metadata: Metadata = {
  title: "הקמת המערכת — Centro",
};

const STEP_META: Record<
  number,
  { title: string; description?: string; help?: string }
> = {
  1: { title: "ברוכים הבאים ל-Centro" },
  2: {
    title: "פרטי המשרד",
    description: "כמה פרטים בסיסיים כדי להתאים את Centro למשרד שלכם.",
    help: "המידע הזה משמש להתאמה אישית של סביבת העבודה שלכם. תמיד ניתן לשנות זאת מאוחר יותר מתוך ההגדרות.",
  },
  3: {
    title: "חיבור שירותים",
    description: "חברו את Google Drive ואת WhatsApp Business כדי שהאוטומציה תוכל לפעול במלואה.",
    help: "אפשר לחבר את השירותים גם מאוחר יותר, אך האוטומציה המלאה תתחיל לפעול רק לאחר ששניהם מחוברים.",
  },
  4: {
    title: "ייבוא לקוחות",
    description: "העלו את רשימת הלקוחות שלכם. Centro יארגן ויסווג אותם אוטומטית.",
    help: "הייבוא מתבצע פעם אחת באשף ההקמה, אך תמיד תוכלו להוסיף, לערוך או לייבא עוד לקוחות מאוחר יותר מעמוד הלקוחות.",
  },
  5: {
    title: "ניתוח AI של הלקוחות",
    description: "Centro ניתח את הקובץ שהעליתם וסיווג את הלקוחות לפי סוג עסק.",
    help: "הסיווג מתבצע אוטומטית על ידי Centro על סמך שם העסק. תמיד ניתן לתקן ידנית — בלי לגעת בקובץ המקורי.",
  },
  6: {
    title: "מסמכים נדרשים",
    description: "עבור כל סוג עסק, בחרו אילו מסמכים Centro צריך לאסוף מהלקוחות.",
    help: "Centro משתמש ברשימות האלו כדי לדעת בדיוק אילו מסמכים לבקש מכל לקוח, לפי סוג העסק שלו.",
  },
  7: {
    title: "כללי תזכורות",
    description: "קבעו מתי ובאיזו תדירות Centro יפנה ללקוחות עבור כל סוג עסק.",
    help: "Centro פונה ללקוחות רק בשעות הפעילות שהגדרתם, ולעולם לא מחוץ להן.",
  },
  8: {
    title: "סיכום",
    description: "בדקו שהכול מוגדר נכון לפני שמתחילים.",
  },
  9: { title: "Centro מוכן!" },
};

function clampStep(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(Math.max(value, 1), TOTAL_STEPS);
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { step: stepParam, error } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  const step = clampStep(Number(stepParam ?? organization.onboardingStep ?? 1) || 1);
  const meta = STEP_META[step];

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
        <Step3Connect
          googleConnectedAt={organization.googleConnectedAt}
          whatsappConnectedAt={organization.whatsappConnectedAt}
        />
      );
      break;
    }
    case 4: {
      body = <Step4Import />;
      break;
    }
    case 5: {
      const businessTypeList = await listBusinessTypes(session.organizationId);
      const unclassified = await listUnclassifiedClients(session.organizationId);
      const clientsByType = await Promise.all(
        businessTypeList.map((type) =>
          listClientsByBusinessType(session.organizationId, type.id)
        )
      );
      body = (
        <Step5Analysis
          businessTypes={businessTypeList}
          clientsByType={clientsByType}
          unclassifiedClients={unclassified}
        />
      );
      break;
    }
    case 6: {
      const businessTypeList = await listBusinessTypes(session.organizationId);
      const withRequirements = await Promise.all(
        businessTypeList.map(async (type) => ({
          businessType: type,
          requirements: await listServiceRequirements(type.serviceId),
          suggested: getSuggestedRequirements(type.name),
        }))
      );
      body = <Step6Documents entries={withRequirements} />;
      break;
    }
    case 7: {
      const businessTypeList = await listBusinessTypes(session.organizationId);
      const withService = await Promise.all(
        businessTypeList.map(async (type) => ({
          businessType: type,
          service: await getService(session.organizationId, type.serviceId),
        }))
      );
      body = <Step7Reminders entries={withService} organization={organization} />;
      break;
    }
    case 8: {
      const businessTypeList = await listBusinessTypes(session.organizationId);
      const clientList = await listClients(session.organizationId);
      const classifiedCount = clientList.filter((c) => c.businessTypeId).length;
      const requirementCounts = await Promise.all(
        businessTypeList.map((t) => listServiceRequirements(t.serviceId))
      );
      body = (
        <Step8Summary
          organization={organization}
          totalClients={clientList.length}
          classifiedCount={classifiedCount}
          businessTypeCount={businessTypeList.length}
          requirementsConfigured={requirementCounts.reduce((sum, r) => sum + r.length, 0)}
        />
      );
      break;
    }
    case 9: {
      body = <Step9Completion />;
      break;
    }
    default: {
      body = null;
    }
  }

  return (
    <WizardShell
      step={step}
      title={meta.title}
      description={meta.description}
      help={meta.help}
      hidePrevious={step === 1}
    >
      {error === "integrations-required" && step === 3 && (
        <p
          role="alert"
          className="mb-4 animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business.
        </p>
      )}
      {body}
    </WizardShell>
  );
}
