import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HelpTip } from "@/components/app/HelpTip";

export const TOTAL_STEPS = 9;

const STEP_TITLES = [
  "ברוכים הבאים",
  "פרטי המשרד",
  "חיבור שירותים",
  "ייבוא לקוחות",
  "ניתוח AI",
  "מסמכים נדרשים",
  "כללי תזכורות",
  "סיכום",
  "סיום",
];

// Shared chrome around every wizard step — progress bar, title/description,
// an optional "why is this important?" tip, and a Previous link back to the
// prior step. Each step renders its own body + primary action inside
// `children` (often its own form's submit button), so this component never
// needs to know how a given step persists its data — the seam that keeps
// inserting a future step a one-file change (add to STEP_TITLES + the
// switch in page.tsx), never a change here.
export function WizardShell({
  step,
  title,
  description,
  help,
  hidePrevious,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  help?: React.ReactNode;
  hidePrevious?: boolean;
  children: React.ReactNode;
}) {
  const progressPercent = Math.round((step / TOTAL_STEPS) * 100);

  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-text-muted">
            <span>
              שלב {step} מתוך {TOTAL_STEPS} — {STEP_TITLES[step - 1]}
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-gradient-to-l from-brand-purple to-brand-blue transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div
          key={step}
          className="animate-fade-in-up rounded-2xl border border-border bg-surface p-6 shadow-card-lg sm:p-8"
        >
          {!hidePrevious && step > 1 && (
            <Link
              href={`/onboarding?step=${step - 1}`}
              className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              חזרה
            </Link>
          )}

          <div className="mb-6 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">{title}</h1>
              {description && (
                <p className="mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">
                  {description}
                </p>
              )}
            </div>
            {help && <HelpTip>{help}</HelpTip>}
          </div>

          {children}
        </div>
      </div>
    </main>
  );
}
