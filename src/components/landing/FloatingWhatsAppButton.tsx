import { WhatsAppOfficialBadge } from "./icons/IntegrationIcons";

export const WHATSAPP_NUMBER = "972559871812";
const WHATSAPP_MESSAGE =
  "היי! 🤖 ראיתי את האתר ואני רוצה ש־Centro תרדוף אחרי המסמכים במקומי.";
const WHATSAPP_HREF = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_MESSAGE)}`;

/**
 * Landing-page-only — mounted from src/app/page.tsx, deliberately not in
 * the root layout, so it never appears on any authenticated/app screen.
 *
 * Mobile: stacked directly above AccessibilityWidget at the same
 * bottom-left corner (left-5, matching AccessibilityWidget's own plain
 * left-5/bottom-5 — no safe-area calc there, so this must match exactly
 * or the two buttons won't align), same 48px (h-12 w-12) size. The
 * bottom offset (5rem) = AccessibilityWidget's own bottom-5 (1.25rem) +
 * its mobile height (3rem) + a 0.75rem gap, so it sits just above it.
 * Desktop (sm:): reverts to the original bottom-right corner with the
 * safe-area-aware offset, unchanged from before.
 */
export default function FloatingWhatsAppButton() {
  return (
    <a
      href={WHATSAPP_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="פתחו שיחת WhatsApp עם Centro"
      className="fixed bottom-[5rem] left-5 z-40 flex h-12 w-12 items-center justify-center transition-transform duration-200 ease-[var(--ease-standard)] hover:scale-[1.07] active:scale-[0.94] sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:left-auto sm:right-[calc(1.5rem+env(safe-area-inset-right))] sm:h-14 sm:w-14"
    >
      <span
        aria-hidden="true"
        className="whatsapp-fab-glow absolute inset-0 -z-10 rounded-full blur-lg"
        style={{ background: "var(--color-whatsapp)" }}
      />
      <WhatsAppOfficialBadge className="h-full w-full drop-shadow-[0_10px_20px_-6px_rgba(37,211,102,0.55)]" />
    </a>
  );
}
