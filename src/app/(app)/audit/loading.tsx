import { SkeletonList } from "@/components/app/Skeleton";

// /audit (Activity History) renders a day-grouped list, not a table -
// SkeletonList matches its actual shape (was SkeletonTable, a mismatch).
export default function AuditLoading() {
  return <SkeletonList rows={8} />;
}
