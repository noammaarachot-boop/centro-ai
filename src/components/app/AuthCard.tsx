// The one auth-screen card shell — replaces the identical
// max-w-sm/rounded-2xl/shadow-card-lg wrapper that was copy-pasted across
// login, forgot-password, and reset-password. `above` renders optional
// content (e.g. a success banner) outside the card itself, stacked above
// it, matching login/page.tsx's existing reset-success-banner placement.
export function AuthCard({
  above,
  children,
}: {
  above?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4">
        {above}
        <div className="rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
          {children}
        </div>
      </div>
    </main>
  );
}
