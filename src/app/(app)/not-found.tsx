import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";

// Renders inside (app)/layout.tsx's <main>, alongside the Sidebar — not a
// full-viewport takeover. Covers any authenticated-app route that doesn't
// resolve (a stale link, a deleted client/service/collection request id).
export default function AppNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg animate-fade-in-up flex-col items-center justify-center px-6 py-10 text-center lg:px-10">
      <span className="centro-icon-purple mb-4 grid h-14 w-14 place-items-center rounded-2xl">
        <SearchX className="h-7 w-7" />
      </span>
      <h1 className="text-xl font-bold text-text-primary">הדף לא נמצא</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
        הדף שחיפשתם לא קיים, הוסר, או שאין לכם הרשאה לצפות בו.
      </p>
      <Link href="/dashboard" className={`mt-6 ${buttonVariants({ variant: "primary" })}`}>
        חזרה ללוח הבקרה
      </Link>
    </div>
  );
}
