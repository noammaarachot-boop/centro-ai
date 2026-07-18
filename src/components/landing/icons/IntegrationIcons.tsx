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

export function GmailGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="2" y="4.5" width="20" height="15" rx="3" fill="currentColor" />
      <path d="M2 6.6 12 13 22 6.6v2.5L12 15.5 2 9.1V6.6Z" fill="#fff" opacity="0.92" />
      <path
        d="M2.4 5.6 12 12l9.6-6.4A2.5 2.5 0 0 0 19.5 4.5h-15A2.5 2.5 0 0 0 2.4 5.6Z"
        fill="#fff"
        opacity="0.22"
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
  | "gmail"
  | "drive"
  | "pdf"
  | "excel"
  | "ai";

export const INTEGRATION_META: Record<
  IntegrationKey,
  { label: string; color: string; Glyph: (p: IconProps) => React.JSX.Element }
> = {
  whatsapp: { label: "WhatsApp", color: "var(--color-whatsapp)", Glyph: WhatsAppGlyph },
  gmail: { label: "Gmail", color: "var(--color-gmail)", Glyph: GmailGlyph },
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
