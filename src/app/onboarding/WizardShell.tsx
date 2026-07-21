import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HelpTip } from "@/components/app/HelpTip";

// Shared chrome around every wizard step — progress bar, title/description,
// an optional "why is this important?" tip, and a Previous link back to the
// prior step. Each step renders its own body + primary action inside
// `children` (often its own form's submit button), so this component never
// needs to know how a given step persists its data.
//
// Product Evolution M3: `totalSteps`/`stepTitle` are now props, not fixed
// constants — the recurring workflow (11 steps) and the one-time workflow
// (9 steps, diverging from step 6 onward) share this same shell but have
// different lengths and step titles from that point on. page.tsx (the one
// place that already knows the organization's workflowType) resolves both
// per request and passes them in; this component stays workflow-agnostic.
export function WizardShell({
  step,
  totalSteps,
  stepTitle,
  title,
  description,
  help,
  hidePrevious,
  children,
}: {
  step: number;
  totalSteps: number;
  stepTitle: string;
  title: string;
  description?: string;
  help?: React.ReactNode;
  hidePrevious?: boolean;
  children: React.ReactNode;
}) {
  const progressPercent = Math.round((step / totalSteps) * 100);

  return (
    <main className="centro-app-ambient flex min-h-screen justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-text-muted">
            <span>
              שלב {step} מתוך {totalSteps} — {stepTitle}
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className="centro-ai-gradient h-full rounded-full transition-all duration-500 ease-[var(--ease-standard)]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div
          key={step}
          className="centro-glass-strong animate-fade-in-up rounded-2xl border border-border p-6 shadow-card-lg sm:p-8"
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
