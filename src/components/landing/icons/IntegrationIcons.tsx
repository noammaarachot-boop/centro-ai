import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Brand-neutral glyphs — evocative of each channel without reproducing
 * trademarked logo artwork pixel-for-pixel.
 */

export function WhatsAppGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 2.5a9.5 9.5 0 0 0-8.2 14.3L2.5 21.5l4.85-1.27A9.5 9.5 0 1 0 12 2.5Z"
        fill="currentColor"
      />
      <path
        d="M8.6 7.4c.22-.02.44 0 .63.02.2.02.46-.07.72.55.27.63.9 2.18.98 2.34.08.16.13.35.02.56-.1.2-.16.33-.31.5-.16.18-.33.4-.47.53-.16.16-.32.33-.14.65.19.31.83 1.38 1.79 2.24 1.23 1.1 2.26 1.44 2.58 1.6.32.16.5.13.69-.08.19-.2.8-.94 1.02-1.26.21-.32.42-.27.7-.16.28.11 1.79.85 2.1 1.01.3.16.5.24.58.37.08.14.08.79-.19 1.55-.27.76-1.55 1.44-2.15 1.53-.55.08-1.24.11-2-.13a17.9 17.9 0 0 1-2.31-.86c-3.4-1.48-5.55-4.98-5.72-5.21-.16-.24-1.38-1.84-1.38-3.5 0-1.67.87-2.48 1.18-2.82.3-.33.66-.4.88-.42Z"
        fill="var(--icon-fg, #fff)"
      />
    </svg>
  );
}

/**
 * Official-style WhatsApp badge — full green circle + the real WhatsApp
 * phone/speech-bubble glyph, unlike WhatsAppGlyph above which is
 * deliberately brand-neutral. Used only where the button's whole purpose
 * is "chat with us on WhatsApp" (FloatingWhatsAppButton, popup/final CTAs)
 * — the exact use case WhatsApp's public brand resources are meant for.
 */
export function WhatsAppOfficialBadge(props: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" {...props}>
      <circle cx="16" cy="16" r="16" fill="#25D366" />
      <path
        fill="#FFFFFF"
        d="M16 6.5c-5.25 0-9.5 4.25-9.5 9.5 0 1.68.44 3.28 1.28 4.7L6.5 25.5l4.95-1.3c1.36.75 2.9 1.15 4.55 1.15 5.25 0 9.5-4.25 9.5-9.5s-4.25-9.35-9.5-9.35zm5.6 13.4c-.24.66-1.4 1.28-1.93 1.34-.5.06-1.1.08-1.77-.11-.4-.12-.93-.3-1.6-.6-2.8-1.2-4.63-4-4.77-4.19-.14-.2-1.14-1.52-1.14-2.9s.72-2.05.98-2.33c.24-.27.53-.34.71-.34h.5c.16 0 .38 0 .58.44.24.55.8 1.9.87 2.04.07.14.12.3.02.48-.09.18-.14.3-.28.46-.14.16-.3.36-.42.48-.14.14-.3.3-.13.58.17.29.75 1.25 1.62 2.02 1.11.99 2.05 1.3 2.33 1.44.29.15.46.13.63-.07.17-.19.72-.85.92-1.14.19-.29.38-.24.63-.14.26.1 1.62.77 1.9.91.27.15.45.22.52.34.07.13.07.72-.17 1.39z"
      />
    </svg>
  );
}

export function DriveGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M8.6 3.5h6.8l6.6 11.4h-6.8L8.6 3.5Z" fill="#3B8CFF" />
      <path d="M4.9 14.9 8.6 3.5l6.6 11.4-3.7 6.4-6.6-6.4Z" fill="#12B886" />
      <path d="M11.5 21.3h9.5l-3.6-6.4H8Z" fill="#F5A524" />
    </svg>
  );
}

export function PDFGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M6 2.5h8.5L19 7v13a1.75 1.75 0 0 1-1.75 1.75h-9.5A1.75 1.75 0 0 1 6 20V4A1.75 1.75 0 0 1 6 2.5Z"
        fill="currentColor"
      />
      <path d="M14.5 2.5 19 7h-3.5a1 1 0 0 1-1-1V2.5Z" fill="#fff" opacity="0.4" />
      <path d="M7 20v-3.6h10V20a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1Z" fill="#000" opacity="0.12" />
      <text
        x="12.5"
        y="17.1"
        textAnchor="middle"
        fontSize="6.6"
        fontWeight="800"
        fill="var(--icon-fg, #fff)"
        fontFamily="var(--font-sans)"
      >
        PDF
      </text>
    </svg>
  );
}

export function ExcelGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M6 2.5h8.5L19 7v13a1.75 1.75 0 0 1-1.75 1.75h-9.5A1.75 1.75 0 0 1 6 20V4A1.75 1.75 0 0 1 6 2.5Z"
        fill="currentColor"
      />
      <path d="M14.5 2.5 19 7h-3.5a1 1 0 0 1-1-1V2.5Z" fill="#fff" opacity="0.4" />
      <path d="M7 20v-3.6h10V20a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1Z" fill="#000" opacity="0.12" />
      <text
        x="12.5"
        y="17.1"
        textAnchor="middle"
        fontSize="6.6"
        fontWeight="800"
        fill="var(--icon-fg, #fff)"
        fontFamily="var(--font-sans)"
      >
        XLS
      </text>
    </svg>
  );
}

export function SparkleGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 2.8c.5 3.4 1.3 5.6 2.5 6.7 1.2 1.2 3.4 2 6.7 2.5-3.3.5-5.5 1.3-6.7 2.5-1.2 1.1-2 3.3-2.5 6.7-.5-3.4-1.3-5.6-2.5-6.7-1.2-1.2-3.4-2-6.7-2.5 3.3-.5 5.5-1.3 6.7-2.5 1.2-1.1 2-3.3 2.5-6.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

export type IntegrationKey =
  | "whatsapp"
  | "drive"
  | "pdf"
  | "excel"
  | "ai";

export const INTEGRATION_META: Record<
  IntegrationKey,
  { label: string; color: string; Glyph: (p: IconProps) => React.JSX.Element }
> = {
  whatsapp: { label: "WhatsApp", color: "var(--color-whatsapp)", Glyph: WhatsAppGlyph },
  drive: { label: "Google Drive", color: "var(--color-drive)", Glyph: DriveGlyph },
  pdf: { label: "PDF", color: "var(--color-pdf)", Glyph: PDFGlyph },
  excel: { label: "Excel", color: "var(--color-excel)", Glyph: ExcelGlyph },
  ai: { label: "AI", color: "var(--color-brand-purple)", Glyph: SparkleGlyph },
};

export function IntegrationBadge({
  type,
  size = 44,
  className = "",
}: {
  type: IntegrationKey;
  size?: number;
  className?: string;
}) {
  const { color, Glyph, label } = INTEGRATION_META[type];
  return (
    <span
      role="img"
      aria-label={label}
      className={`relative inline-flex items-center justify-center rounded-2xl ring-1 ring-white/80 ${className}`}
      style={{
        width: size,
        height: size,
        color,
        background:
          "linear-gradient(155deg, #ffffff 0%, #ffffff 55%, color-mix(in oklab, var(--color-surface-muted) 70%, white) 100%)",
        boxShadow: `0 10px 26px -10px color-mix(in oklab, ${color} 60%, transparent), 0 2px 5px -1px color-mix(in oklab, ${color} 25%, transparent), inset 0 1px 0 rgba(255,255,255,0.9)`,
      }}
    >
      <Glyph style={{ width: size * 0.56, height: size * 0.56 }} />
    </span>
  );
}
