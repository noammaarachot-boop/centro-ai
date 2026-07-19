import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "מדיניות פרטיות — Centro",
};

export default function PrivacyPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-4 py-16">
      <div className="w-full max-w-2xl">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לעמוד הבית
        </Link>
        <div className="rounded-2xl border border-border bg-surface p-8 shadow-card-lg">
          <h1 className="mb-3 text-2xl font-semibold text-text-primary">מדיניות פרטיות</h1>
          <p className="text-sm leading-relaxed text-text-secondary">
            הנוסח המלא של מדיניות הפרטיות של Centro יפורסם כאן בקרוב. במידה ויש לכם שאלות
            בנוגע לאופן שבו אנו מטפלים במידע שלכם, ניתן ליצור קשר בכתובת{" "}
            <a href="mailto:hello@centro.example.com" className="text-brand-purple hover:underline">
              hello@centro.example.com
            </a>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
