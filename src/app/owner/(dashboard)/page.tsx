import { t } from "@/lib/owner/i18n/t";

// Placeholder landing page for Phase 0 — proves the auth foundation works
// end to end (login → guarded route → session → logout). The real
// executive home dashboard (KPIs, health indicator, activity feed) is
// built in a later phase per the approved Owner Dashboard plan.
export default function OwnerHomePage() {
  return (
    <div
      className="rounded-2xl border p-8"
      style={{ borderColor: "var(--owner-border)", background: "var(--owner-surface)" }}
    >
      <h1 className="text-lg font-bold" style={{ color: "var(--owner-text-primary)" }}>
        {t("owner.home.placeholderTitle")}
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--owner-text-secondary)" }}>
        {t("owner.home.placeholderDescription")}
      </p>
    </div>
  );
}
