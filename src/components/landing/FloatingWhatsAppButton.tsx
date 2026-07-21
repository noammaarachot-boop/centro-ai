import { WhatsAppGlyph } from "./icons/IntegrationIcons";

const WHATSAPP_NUMBER = "972559871812";
const WHATSAPP_MESSAGE =
  "היי! 🤖 ראיתי את האתר ואני רוצה ש־Centro תרדוף אחרי המסמכים במקומי.";
const WHATSAPP_HREF = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_MESSAGE)}`;

/**
 * Landing-page-only — mounted from src/app/page.tsx, deliberately not in
 * the root layout, so it never appears on any authenticated/app screen.
 * Bottom-right (AccessibilityWidget already owns bottom-left, see
 * AccessibilityWidget.tsx) with the same spacing scale for visual parity.
 */
export default function FloatingWhatsAppButton() {
  return (
    <a
      href={WHATSAPP_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="פתחו שיחת WhatsApp עם Centro"
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] right-[calc(1.25rem+env(safe-area-inset-right))] z-40 flex h-14 w-14 items-center justify-center transition-transform duration-200 ease-[var(--ease-standard)] hover:scale-[1.07] active:scale-[0.94] sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:right-[calc(1.5rem+env(safe-area-inset-right))]"
    >
      <span
        aria-hidden="true"
        className="whatsapp-fab-glow absolute inset-0 -z-10 rounded-full blur-lg"
        style={{ background: "var(--color-whatsapp)" }}
      />
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-whatsapp text-white shadow-card-lg">
        <WhatsAppGlyph className="h-7 w-7" />
      </span>
    </a>
  );
}
