import { SkeletonPage } from "@/components/app/Skeleton";

// /services renders a card-grid, not a table - SkeletonPage matches its
// actual shape (was SkeletonTable, a mismatch).
export default function ServicesLoading() {
  return <SkeletonPage cards={4} />;
}
