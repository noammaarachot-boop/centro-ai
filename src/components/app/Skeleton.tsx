import { clsx } from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={clsx("centro-skeleton rounded-lg", className)} aria-hidden="true" />
  );
}

export function SkeletonPage({ cards = 3 }: { cards?: number }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12 lg:px-10">
      <Skeleton className="mb-2 h-7 w-56" />
      <Skeleton className="mb-8 h-4 w-96 max-w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            className="centro-glass rounded-2xl border border-border p-5 shadow-card"
          >
            <Skeleton className="mb-4 h-4 w-24" />
            <Skeleton className="mb-2 h-8 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonDetail({ sections = 3 }: { sections?: number }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10 lg:px-10">
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="mb-8 h-7 w-64 max-w-full" />
      <div className="space-y-6">
        {Array.from({ length: sections }).map((_, i) => (
          <div
            key={i}
            className="centro-glass rounded-2xl border border-border p-6 shadow-card"
          >
            <Skeleton className="mb-4 h-4 w-32" />
            <Skeleton className="mb-2.5 h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

// For day-grouped/card-list pages (Activity History) rather than a real
// <table> — a plain stack of row-cards, distinct from SkeletonTable's
// single bordered block with internal dividers.
export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-8 h-4 w-80 max-w-full" />
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="centro-glass rounded-xl border border-border p-4 shadow-card"
          >
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12 lg:px-10">
      <Skeleton className="mb-2 h-7 w-48" />
      <Skeleton className="mb-8 h-4 w-72 max-w-full" />
      <div className="centro-glass overflow-hidden rounded-2xl border border-border shadow-card">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/6" />
            <Skeleton className="h-4 w-1/6" />
            <Skeleton className="h-4 w-1/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
