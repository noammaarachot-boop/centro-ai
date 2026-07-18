import { CentroMark } from "./icons/CentroMark";

const FOOTER_LINKS = [
  { href: "#how-it-works", label: "איך זה עובד" },
  { href: "#capabilities", label: "יכולות" },
  { href: "#demo", label: "הדגמה" },
];

const LEGAL_LINKS = [
  { href: "#", label: "מדיניות פרטיות" },
  { href: "#", label: "תנאי שימוש" },
  { href: "mailto:hello@centro.example.com", label: "יצירת קשר" },
];

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="relative border-t border-border py-12">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="text-center sm:text-right">
            <div className="flex items-center justify-center gap-2 sm:justify-start">
              <CentroMark className="h-8 w-8" title="Centro" />
              <span className="text-lg font-bold tracking-tight" dir="ltr">
                Centro
              </span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-text-secondary">
              העובד הדיגיטלי שאוסף, מנתח ומסדר מסמכים עבור משרדי ראיית
              חשבון — כדי שאתם תתמקדו במה שחשוב באמת.
            </p>
          </div>

          <nav
            className="flex flex-col items-center gap-2 sm:items-start"
            aria-label="ניווט בפוטר"
          >
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              ניווט
            </span>
            {FOOTER_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <nav
            className="flex flex-col items-center gap-2 sm:items-start"
            aria-label="מידע משפטי"
          >
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              מידע
            </span>
            {LEGAL_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-10 flex flex-col items-center gap-3 border-t border-border pt-6 text-xs text-text-muted sm:flex-row sm:justify-between">
          <p>© {year} Centro. כל הזכויות שמורות.</p>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-emerald opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-emerald" />
            </span>
            המערכת פעילה
          </div>
        </div>
      </div>
    </footer>
  );
}
