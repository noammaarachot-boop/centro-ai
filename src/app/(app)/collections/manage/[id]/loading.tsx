import { SkeletonDetail } from "@/components/app/Skeleton";

// Real page renders up to 5 cards (details, requirements, client
// assignment, send request) plus the delete link.
export default function CollectionRequestManageLoading() {
  return <SkeletonDetail sections={5} />;
}
