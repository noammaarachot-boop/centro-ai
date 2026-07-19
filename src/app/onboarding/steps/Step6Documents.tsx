import { Check, Plus, X } from "lucide-react";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { advanceOnboardingStep } from "../actions";
import { addRequirement, removeRequirement } from "@/app/(app)/services/actions";

interface Requirement {
  id: string;
  name: string;
}

interface Entry {
  businessType: { id: string; name: string; serviceId: string };
  requirements: Requirement[];
  suggested: Array<{ name: string; defaultChecked: boolean }>;
}

export function Step6Documents({ entries }: { entries: Entry[] }) {
  const goToStep7 = advanceOnboardingStep.bind(null, 7);

  if (entries.length === 0) {
    return (
      <div className="space-y-5">
        <p className="text-sm text-text-secondary">
          עדיין אין סוגי עסק מוגדרים — הם נוצרים אוטומטית ברגע שיש לקוחות מסווגים בשלב
          הקודם. אפשר תמיד להגדיר מסמכים נדרשים מאוחר יותר מעמוד השירותים.
        </p>
        <form action={goToStep7}>
          <button
            type="submit"
            className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
          >
            המשך
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {entries.map(({ businessType, requirements, suggested }) => {
        const addAction = addRequirement.bind(null, businessType.serviceId);
        const existingNames = new Set(requirements.map((r) => r.name));
        const notYetAdded = suggested.filter((s) => !existingNames.has(s.name));

        return (
          <Card key={businessType.id}>
            <h3 className="mb-3 text-sm font-semibold text-text-primary">{businessType.name}</h3>

            {requirements.length > 0 && (
              <ul className="mb-3 space-y-1.5">
                {requirements.map((req) => (
                  <li
                    key={req.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-brand-emerald/20 bg-brand-emerald/5 px-3 py-2 text-xs"
                  >
                    <span className="flex items-center gap-1.5 text-text-primary">
                      <Check className="h-3.5 w-3.5 text-brand-emerald" />
                      {req.name}
                    </span>
                    <form action={removeRequirement.bind(null, businessType.serviceId, req.id)}>
                      <input type="hidden" name="returnTo" value="/onboarding?step=6" />
                      <button
                        type="submit"
                        aria-label={`הסרת ${req.name}`}
                        className="text-text-muted transition-colors hover:text-danger"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {notYetAdded.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {notYetAdded.map((s) => (
                  <form key={s.name} action={addAction}>
                    <input type="hidden" name="name" value={s.name} />
                    <input type="hidden" name="returnTo" value="/onboarding?step=6" />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
                    >
                      <Plus className="h-3 w-3" />
                      {s.name}
                    </button>
                  </form>
                ))}
              </div>
            )}

            <form action={addAction} className="flex items-center gap-2">
              <input type="hidden" name="returnTo" value="/onboarding?step=6" />
              <input
                name="name"
                type="text"
                required
                placeholder="הוספת מסמך מותאם אישית..."
                className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
              <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                הוספה
              </button>
            </form>
          </Card>
        );
      })}

      <form action={goToStep7}>
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </button>
      </form>
    </div>
  );
}
