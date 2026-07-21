import Link from "next/link";
import { CentroMarkGlow } from "@/components/app/CentroMarkGlow";

// The one auth-screen card shell — replaces the identical
// max-w-sm/rounded-2xl/shadow-card-lg wrapper that was copy-pasted across
// login, forgot-password, and reset-password. `above` renders optional
// content (e.g. a success banner) outside the card itself, stacked above
// it, matching login/page.tsx's existing reset-success-banner placement.
// The `.centro-app-ambient` background (globals.css, Milestone 0 — a
// restrained, static two-blob wash, distinct from the landing page's
// busier animated aurora) applies to every auth screen automatically.
// `showMark` is opt-in (only the login/register screen passes it) so
// forgot-password/reset-password stay exactly as they already are.
export function AuthCard({
  above,
  showMark,
  children,
}: {
  above?: React.ReactNode;
  showMark?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="centro-app-ambient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-in-up space-y-4">
        {above}
        <div className="centro-glass-strong rounded-2xl border border-border p-8 shadow-card-lg">
          {showMark && (
            <div className="mb-4 flex justify-center">
              <CentroMarkGlow size={40} breathe glow />
            </div>
          )}
          {children}
        </div>
        <p className="text-center text-xs text-text-muted">
          <Link href="/terms" target="_blank" rel="noopener noreferrer" className="hover:text-brand-purple hover:underline">
            תנאי שימוש
          </Link>
          {" · "}
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-brand-purple hover:underline">
            מדיניות פרטיות
          </Link>
        </p>
      </div>
    </main>
  );
}
