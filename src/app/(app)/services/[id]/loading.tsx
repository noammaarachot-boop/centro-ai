import { SkeletonDetail } from "@/components/app/Skeleton";

// Real page renders 4 cards (details, requirements, schedule overrides,
// assigned clients) - 3 undercounted the actual shape.
export default function ServiceDetailLoading() {
  return <SkeletonDetail sections={4} />;
}
