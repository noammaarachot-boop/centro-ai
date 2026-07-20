import { SkeletonDetail } from "@/components/app/Skeleton";

// Real page renders up to 5 cards (details, business type, document
// profile, assigned services/templates, plus the delete link) - 2
// undercounted the actual shape.
export default function ClientDetailLoading() {
  return <SkeletonDetail sections={5} />;
}
