import { SkeletonDetail } from "@/components/app/Skeleton";

// Real page can render up to 7 cards (status transition, requirements,
// unmatched documents, pending confirmations, conversation, audit
// history) - 4 undercounted the actual shape.
export default function CollectionDetailLoading() {
  return <SkeletonDetail sections={6} />;
}
