// The one auth-screen card shell — replaces the identical
// max-w-sm/rounded-2xl/shadow-card-lg wrapper that was copy-pasted across
// login, forgot-password, and reset-password. `above` renders optional
// content (e.g. a success banner) outside the card itself, stacked above
// it, matching login/page.tsx's existing reset-success-banner placement.
// The `.centro-app-ambient` background (globals.css, Milestone 0 — a
// restrained, static two-blob wash, distinct from the landing page's
// busier animated aurora) applies to every auth screen automatically.
export function AuthCard({
  above,
  children,
}: {
  above?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="centro-app-ambient flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-in-up space-y-4">
        {above}
        <div className="rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
          {children}
        </div>
      </div>
    </main>
  );
}
