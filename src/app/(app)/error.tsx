"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";

// The one error boundary for the whole authenticated app — Next requires
// this to be a Client Component. Renders inside (app)/layout.tsx's <main>,
// alongside the Sidebar, not as a full-viewport takeover.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg animate-fade-in-up flex-col items-center justify-center px-6 py-10 text-center lg:px-10">
      <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-danger/10 text-danger">
        <AlertTriangle className="h-7 w-7" />
      </span>
      <h1 className="text-xl font-bold text-text-primary">משהו השתבש</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
        אירעה שגיאה בלתי צפויה. אפשר לנסות שוב, או לחזור ללוח הבקרה.
      </p>
      <div className="mt-6 flex items-center gap-2">
        <button type="button" onClick={reset} className={buttonVariants({ variant: "primary" })}>
          ניסיון חוזר
        </button>
        <Link href="/dashboard" className={buttonVariants({ variant: "secondary" })}>
          ללוח הבקרה
        </Link>
      </div>
    </div>
  );
}
