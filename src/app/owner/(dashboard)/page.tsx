import { Card } from "@/components/app/Card";
import { t } from "@/lib/owner/i18n/t";

// Placeholder landing page for Phase 0 — proves the auth foundation works
// end to end (login → guarded route → session → logout). The real
// executive home dashboard (KPIs, health indicator, activity feed) is
// built in a later phase per the approved Owner Dashboard plan.
export default function OwnerHomePage() {
  return (
    <Card>
      <h1 className="text-lg font-bold text-text-primary">{t("owner.home.placeholderTitle")}</h1>
      <p className="mt-2 text-sm text-text-secondary">{t("owner.home.placeholderDescription")}</p>
    </Card>
  );
}
