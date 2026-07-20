import { SkeletonDetail } from "@/components/app/Skeleton";

// Real page renders 4 cards (business details, automation, schedule form,
// run-scheduler) - 2 undercounted the actual shape.
export default function SettingsLoading() {
  return <SkeletonDetail sections={4} />;
}
