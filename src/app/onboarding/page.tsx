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
import { getLatestAuditEventByType } from "@/lib/data/auditLog";
import type { ImportAnalysisSummary } from "./actions";
import { WizardShell, TOTAL_STEPS } from "./WizardShell";
import { Step1Welcome } from "./steps/Step1Welcome";
import { Step2OfficeInfo } from "./steps/Step2OfficeInfo";
import { Step3BusinessType } from "./steps/Step3BusinessType";
import { Step4CollectionStyle } from "./steps/Step4CollectionStyle";
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

// Product Evolution M1: two new steps (3, 4) inserted after Office Info;
// the wizard's original Steps 3-9 shift to 5-11. Step component filenames
// keep their original numbers (Step3Connect, Step4Import, ...) — renaming
// seven files for a cosmetic match to their new position is pure churn,
// especially since M3 branches this further. STEP_META's keys are the
// source of truth for actual wizard position.
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
    title: "סוג העסק",
    description: "איזה סוג עסק אתם מנהלים? זה עוזר ל-Centro להתאים את חוויית ההקמה עבורכם.",
    help: "המידע משמש להתאמה אישית של ההקמה, לשיפור המוצר, ולהצעות מסמכים חכמות — גם אם מעולם לא נתקלנו בסוג העסק שלכם, Centro תמיד יציע נקודת התחלה שימושית.",
  },
  4: {
    title: "אופן איסוף המסמכים",
    description: "איך אתם בדרך כלל אוספים מסמכים מהלקוחות שלכם?",
    help: "הבחירה כאן קובעת את כל חוויית העבודה עם Centro מכאן ואילך.",
  },
  5: {
    title: "חיבור שירותים",
    description: "חברו את Google Drive ואת WhatsApp Business כדי שהאוטומציה תוכל לפעול במלואה.",
    help: "אפשר לחבר את השירותים גם מאוחר יותר, אך האוטומציה המלאה תתחיל לפעול רק לאחר ששניהם מחוברים.",
  },
  6: {
    title: "ייבוא לקוחות",
    description: "העלו את רשימת הלקוחות שלכם. Centro יארגן ויסווג אותם אוטומטית.",
    help: "הייבוא מתבצע פעם אחת באשף ההקמה, אך תמיד תוכלו להוסיף, לערוך או לייבא עוד לקוחות מאוחר יותר מעמוד הלקוחות.",
  },
  7: {
    title: "ניתוח AI של הלקוחות",
    description: "Centro ניתח את הקובץ שהעליתם וסיווג את הלקוחות לפי סוג עסק.",
    help: "הסיווג מתבצע אוטומטית על ידי Centro על סמך שם העסק. תמיד ניתן לתקן ידנית — בלי לגעת בקובץ המקורי.",
  },
  8: {
    title: "מסמכים נדרשים",
    description: "עבור כל סוג עסק, בחרו אילו מסמכים Centro צריך לאסוף מהלקוחות.",
    help: "Centro משתמש ברשימות האלו כדי לדעת בדיוק אילו מסמכים לבקש מכל לקוח, לפי סוג העסק שלו.",
  },
  9: {
    title: "כללי תזכורות",
    description: "קבעו מתי ובאיזו תדירות Centro יפנה ללקוחות עבור כל סוג עסק.",
    help: "Centro פונה ללקוחות רק בשעות הפעילות שהגדרתם, ולעולם לא מחוץ להן.",
  },
  10: {
    title: "סיכום",
    description: "בדקו שהכול מוגדר נכון לפני שמתחילים.",
  },
  11: { title: "Centro מוכן!" },
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
        <Step3BusinessType
          businessCategory={organization.businessCategory}
          businessCategoryCustomLabel={organization.businessCategoryCustomLabel}
        />
      );
      break;
    }
    case 4: {
      body = <Step4CollectionStyle />;
      break;
    }
    case 5: {
      body = (
        <Step3Connect
          googleConnectedAt={organization.googleConnectedAt}
          whatsappConnectedAt={organization.whatsappConnectedAt}
        />
      );
      break;
    }
    case 6: {
      body = <Step4Import />;
      break;
    }
    case 7: {
      const businessTypeList = await listBusinessTypes(session.organizationId);
      const unclassified = await listUnclassifiedClients(session.organizationId);
      const clientsByType = await Promise.all(
        businessTypeList.map((type) =>
          listClientsByBusinessType(session.organizationId, type.id)
        )
      );
      const latestAnalysis = await getLatestAuditEventByType(
        session.organizationId,
        "clients.import_analyzed"
      );
      body = (
        <Step5Analysis
          businessTypes={businessTypeList}
          clientsByType={clientsByType}
          unclassifiedClients={unclassified}
          importSummary={latestAnalysis?.metadata as ImportAnalysisSummary | undefined}
        />
      );
      break;
    }
    case 8: {
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
    case 9: {
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
    case 10: {
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
    case 11: {
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
      {error === "integrations-required" && step === 5 && (
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
