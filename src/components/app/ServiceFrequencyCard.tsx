import { Card } from "@/components/app/Card";
import { Button } from "@/components/app/Button";
import { FrequencyField } from "@/components/app/FrequencyField";
import { updateServiceFrequency } from "@/app/(app)/services/actions";

// Product Evolution M9 — "Collection frequency" (when a new cycle opens)
// deliberately lives in its own card, separate from
// ServiceScheduleOverrideCard's reminder/business-hours fields (what
// happens inside an already-open cycle) — see recurringScheduler.ts's own
// module comment for why these are modeled as distinct concepts.
export function ServiceFrequencyCard({
  serviceId,
  collectionFrequencyIntervalMonths,
}: {
  serviceId: string;
  collectionFrequencyIntervalMonths: number | null;
}) {
  const action = updateServiceFrequency.bind(null, serviceId);

  return (
    <Card>
      <form action={action} className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">תדירות האיסוף</h3>
          <p className="mt-1 text-xs text-text-muted">
            כל כמה זמן Centro פותח אוטומטית מחזור איסוף חדש עבור כל לקוח המשויך.
          </p>
        </div>
        <FrequencyField defaultValue={collectionFrequencyIntervalMonths} />
        <Button type="submit" variant="secondary" size="sm">
          שמירה
        </Button>
      </form>
    </Card>
  );
}
