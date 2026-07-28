import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { needsOnboarding } from "@/lib/onboarding";
import { listClients } from "@/lib/data/clients";
import { listServiceRequirements, getService } from "@/lib/data/services";
import {
  getSuggestedRequirements,
  listBusinessTypes,
  listClientsByBusinessType,
  listPendingClassificationSuggestions,
  listUnclassifiedClients,
} from "@/lib/businessTypes";
import { getLatestAuditEventByType } from "@/lib/data/auditLog";
import { getBusinessCategoryIcon, getBusinessCategoryLabel } from "@/lib/businessCategories";
import type { ImportAnalysisSummary } from "./actions";
import { WizardShell } from "./WizardShell";
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
import { Step6OneTimeImport } from "./steps/Step6OneTimeImport";
import { Step7WorkingHours } from "./steps/Step7WorkingHours";
import { Step8OneTimeSummary } from "./steps/Step8OneTimeSummary";
import { Step9OneTimeCompletion } from "./steps/Step9OneTimeCompletion";

export const metadata: Metadata = {
  title: "הקמת המערכת — Centro",
};

type StepMeta = { title: string; description?: string; help?: string };

// Steps 1-4 are identical for both workflows — the fork (Collection Style,
// Step 4) only changes what step 5 onward looks like. Step component
// filenames keep their original (pre-M1) numbers where reused
// (Step3Connect, Step4Import, ...) — renaming them for a cosmetic match to
// their current wizard position is pure churn. STEP_META's keys are the
// one source of truth for actual wizard position.
//
// First-Send Journey — Step3Connect (Connect Google Drive + WhatsApp) used
// to be shared step 5 for both flows. It's now recurring-only (moved into
// RECURRING_STEP_META below, still key 5, so recurring's numbering is
// completely unchanged): the on-demand flow connects for the first time
// inside the Collection Requests wizard, in-context, right before its
// first send — recurring keeps connecting during onboarding because its
// automation runs unattended, with no per-send human checkpoint to enforce
// it at otherwise. This is why on-demand's own steps below start at 5, not
// 6 — one step shorter than before.
const SHARED_STEP_META: Record<number, StepMeta> = {
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
    title: "אופן איסוף המסמכים",
    description: "איך אתם בדרך כלל אוספים מסמכים מהלקוחות שלכם?",
    help: "הבחירה כאן קובעת רק את שלבי ההקמה הבאים — אחרי ההקמה, כל משרד יכול להשתמש גם באיסוף מחזורי וגם באיסוף לפי צורך, בכל עת.",
  },
};

const RECURRING_STEP_META: Record<number, StepMeta> = {
  5: {
    title: "חיבור שירותים",
    description: "יש לחבר את Google Drive ואת WhatsApp Business כדי להמשיך — שני החיבורים הכרחיים להמשך ההקמה.",
    help: "לא ניתן להמשיך לשלב הבא לפני ששני השירותים מחוברים: Centro פונה ללקוחות ומקבל מהם מסמכים דרך WhatsApp, ושומר כל מסמך מאושר ב-Drive שלכם — בלעדיהם אין מה לאסוף ואיפה לשמור. ניתן תמיד לנתק ולהתחבר מחדש בהמשך, מתוך ההגדרות.",
  },
  6: {
    title: "ייבוא לקוחות",
    description: "העלו את רשימת הלקוחות שלכם. Centro יארגן ויסווג אותם אוטומטית.",
    help: "הייבוא מתבצע פעם אחת באשף ההקמה, אך תמיד תוכלו להוסיף, לערוך או לייבא עוד לקוחות מאוחר יותר מעמוד הלקוחות.",
  },
  7: {
    title: "סיווג הלקוחות שלכם",
    description: "Centro הציע סיווג לכל לקוח שיובא, לפי סוג העסק. בדקו ואשרו לפני שממשיכים.",
    help: "ההצעה מבוססת על שם העסק ופרטים נוספים מהקובץ שהעליתם. תמיד ניתן לתקן ידנית — בלי לגעת בקובץ המקורי.",
  },
  8: {
    title: "מסמכים נדרשים",
    description: "עבור כל סוג עסק, בחרו אילו מסמכים Centro צריך לאסוף מהלקוחות.",
    help: "Centro משתמש ברשימות האלו כדי לדעת בדיוק אילו מסמכים לבקש מכל לקוח, לפי סוג העסק שלו.",
  },
  9: {
    title: "תדירות ותזכורות",
    description: "עבור כל סוג עסק: כל כמה זמן נפתח מחזור איסוף חדש, וכיצד Centro פונה ללקוחות בתוך מחזור פתוח.",
    help: "אלו שני דברים נפרדים: התדירות קובעת מתי מתחיל מחזור חדש; כללי התזכורות קובעים מה קורה בתוך מחזור שכבר פתוח וממתין למסמכים. Centro פונה ללקוחות רק בשעות הפעילות שהגדרתם, ולעולם לא מחוץ להן.",
  },
  10: {
    title: "סיכום",
    description: "בדקו שהכול מוגדר נכון לפני שמתחילים.",
  },
  11: { title: "Centro מוכן!" },
};

// First-Send Journey — renumbered 5-8 (was 6-9): no Connect step in this
// flow anymore, so every later step moved down by one. See the comment
// above RECURRING_STEP_META for why.
const ONE_TIME_STEP_META: Record<number, StepMeta> = {
  5: {
    title: "ייבוא לקוחות (אופציונלי)",
    description: "אפשר לייבא כבר עכשיו רשימת לקוחות, או לדלג ולהוסיף מאוחר יותר.",
    help: "בתהליך העבודה החד-פעמי נשמרים רק שם וטלפון — ללא סיווג או ניתוח נוסף. ייבוא הוא תמיד אופציונלי.",
  },
  6: {
    title: "שעות פעילות",
    description: "באילו ימים ושעות Centro רשאי לפנות ללקוחות?",
    help: "Centro פונה ללקוחות רק בשעות הפעילות שהגדרתם, ולעולם לא מחוץ להן — גם בתהליך עבודה חד-פעמי.",
  },
  7: {
    title: "סיכום",
    description: "בדקו שהכול מוגדר נכון לפני שמתחילים.",
  },
  8: { title: "Centro מוכן!" },
};

const RECURRING_TOTAL_STEPS = 11;
const ONE_TIME_TOTAL_STEPS = 8;

// Product Evolution M9 — "recurring" and "both" both get the fuller
// (recurring) wizard path, since post-onboarding on-demand needs no setup
// steps of its own (see Step4CollectionStyle.tsx's own help text: "the
// On-Demand option is available right after, from the menu, with no
// further setup"). "on_demand" is the current value; "one_time" is the
// pre-M9 value, kept meaning exactly the same thing.
function isShortWizardFlow(workflowType: string): boolean {
  return workflowType === "one_time" || workflowType === "on_demand";
}

function stepMetaFor(workflowType: string, step: number): StepMeta {
  if (step <= 4) return SHARED_STEP_META[step];
  return (isShortWizardFlow(workflowType) ? ONE_TIME_STEP_META : RECURRING_STEP_META)[step];
}

function stepTitleFor(workflowType: string, totalSteps: number): string[] {
  const titles: string[] = [];
  for (let i = 1; i <= totalSteps; i += 1) titles.push(stepMetaFor(workflowType, i).title);
  return titles;
}

function clampStep(value: number, totalSteps: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(Math.max(value, 1), totalSteps);
}

// Every ?error= code that can land back on step 5 (Step3Connect) —
// the automation-activation gate (Settings) and every Google OAuth
// failure mode (src/app/api/auth/google/*, onboarding/actions.ts).
const STEP5_ERROR_MESSAGES: Record<string, string> = {
  "integrations-required": "לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business.",
  "google-denied": "החיבור לחשבון Google בוטל.",
  "google-invalid-state": "אימות החיבור לחשבון Google נכשל. נסו לחבר שוב.",
  "google-oauth-failed": "החיבור לחשבון Google נכשל. נסו שוב בעוד רגע.",
  "google-not-configured": "חיבור Google אינו זמין כרגע. פנו לתמיכה.",
  "google-folder-failed": "בחירת/יצירת התיקייה ב-Drive נכשלה. נסו שוב.",
  "both-required": "כדי להשלים את ההקמה, יש לחבר גם WhatsApp Business וגם Google Drive — שניהם הכרחיים כדי ש-Centro יוכל לתקשר עם לקוחות ולשמור מסמכים.",
  "whatsapp-required": "כדי להשלים את ההקמה, יש לחבר את WhatsApp Business — כך Centro פונה ללקוחות ומקבל מהם מסמכים.",
  "drive-required": "כדי להשלים את ההקמה, יש לחבר את Google Drive ולבחור תיקייה — כך Centro שומר את המסמכים המאושרים.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { step: stepParam, error } = await searchParams;

  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  // M8 hardening — the mirror image of the (app) layout's own guard. Without
  // this, a fully onboarded organization could navigate straight back into
  // the wizard and resubmit its one-time setup steps (re-running the
  // import/seeding logic, etc.) by accident. Product Evolution M9:
  // updateWorkflowType itself is no longer a permanent lock on runtime
  // behavior (see its own comment) — this guard is purely about not
  // letting a completed wizard run its setup actions again, not about
  // preventing a mode change (there is none to prevent; every organization
  // can use both collection modes once onboarded).
  if (!needsOnboarding(organization)) {
    redirect("/dashboard");
  }

  const totalSteps = isShortWizardFlow(organization.workflowType)
    ? ONE_TIME_TOTAL_STEPS
    : RECURRING_TOTAL_STEPS;
  const step = clampStep(Number(stepParam ?? organization.onboardingStep ?? 1) || 1, totalSteps);
  const meta = stepMetaFor(organization.workflowType, step);
  const stepTitles = stepTitleFor(organization.workflowType, totalSteps);

  let body: React.ReactNode;

  if (step <= 4) {
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
    }
  } else if (isShortWizardFlow(organization.workflowType)) {
    switch (step) {
      case 5: {
        const clientList = await listClients(session.organizationId);
        body = <Step6OneTimeImport totalClients={clientList.length} />;
        break;
      }
      case 6: {
        body = (
          <Step7WorkingHours
            businessHoursStart={organization.businessHoursStart}
            businessHoursEnd={organization.businessHoursEnd}
            businessDays={organization.businessDays}
          />
        );
        break;
      }
      case 7: {
        const clientList = await listClients(session.organizationId);
        body = <Step8OneTimeSummary organization={organization} totalClients={clientList.length} />;
        break;
      }
      case 8: {
        body = <Step9OneTimeCompletion />;
        break;
      }
      default: {
        body = null;
      }
    }
  } else {
    switch (step) {
      case 5: {
        body = (
          <Step3Connect
            googleConnectedAt={organization.googleConnectedAt}
            googleDriveFolderId={organization.googleDriveFolderId}
            googleDriveFolderName={organization.googleDriveFolderName}
            whatsappConnectedAt={organization.whatsappConnectedAt}
            whatsappDisplayPhoneNumber={organization.whatsappDisplayPhoneNumber}
            isQaMode={!!organization.qaModeEnabledAt}
          />
        );
        break;
      }
      case 6: {
        const existingTypes = await listBusinessTypes(session.organizationId);
        body = <Step4Import existingTypes={existingTypes} />;
        break;
      }
      case 7: {
        const businessTypeList = await listBusinessTypes(session.organizationId);
        const unclassified = await listUnclassifiedClients(session.organizationId);
        const pendingSuggestions = await listPendingClassificationSuggestions(session.organizationId);
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
            pendingSuggestions={pendingSuggestions}
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
        const classifiedCount = clientList.filter((c) => c.classificationConfirmedAt).length;
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
  }

  // Item 6 — visible from step 4 onward only (step 3 is where it's chosen;
  // showing it there too would just echo the picker back at itself).
  const businessCategoryLabel =
    step >= 4
      ? getBusinessCategoryLabel(organization.businessCategory, organization.businessCategoryCustomLabel)
      : undefined;
  const businessCategoryIcon = step >= 4 ? getBusinessCategoryIcon(organization.businessCategory) : undefined;

  return (
    <WizardShell
      step={step}
      totalSteps={totalSteps}
      stepTitle={stepTitles[step - 1]}
      title={meta.title}
      description={meta.description}
      help={meta.help}
      hidePrevious={step === 1}
      businessCategoryLabel={businessCategoryLabel}
      businessCategoryIcon={businessCategoryIcon}
    >
      {error && step === 5 && !isShortWizardFlow(organization.workflowType) && STEP5_ERROR_MESSAGES[error] && (
        <p
          role="alert"
          className="mb-4 animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          {STEP5_ERROR_MESSAGES[error]}
        </p>
      )}
      {body}
    </WizardShell>
  );
}
