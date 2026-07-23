// The recurring "start a free trial" CTA — same gradient as every other
// button on the page (bg-gradient-to-l from-brand-purple to-brand-blue),
// never green (green is reserved for WhatsApp across the whole site).
// `inverse` is for placements where the CTA already sits on a colored/
// gradient surface (TrustSection's card, FinalCTASection) and needs a
// white button instead of a colored one on a colored background.
export default function TrialCta({
  variant = "default",
  className = "",
}: {
  variant?: "default" | "inverse";
  className?: string;
}) {
  const isInverse = variant === "inverse";
  return (
    <a
      href="/register"
      className={`flex flex-col items-center justify-center gap-0.5 rounded-full px-7 py-3.5 text-center shadow-card-lg transition-transform hover:scale-[1.02] active:scale-[0.98] ${
        isInverse
          ? "bg-white text-brand-purple-deep"
          : "bg-gradient-to-l from-brand-purple to-brand-blue text-white"
      } ${className}`}
    >
      <span className="text-base font-semibold">התחילו ניסיון חינם של 14 יום</span>
      <span
        className={`text-xs font-medium ${isInverse ? "text-text-secondary" : "text-white/85"}`}
      >
        ללא כרטיס אשראי · ללא התחייבות
      </span>
    </a>
  );
}
