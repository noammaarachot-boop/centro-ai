import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { resolveHumanReviewAfterDays } from "@/lib/attention/policy";

/**
 * One organization's "מתי להעביר בקשה לטיפול אנושי?" setting.
 *
 * Kept apart from policy.ts so that module stays pure and directly testable;
 * this is the single tenant-scoped read of the setting, so no caller has to
 * remember which column it lives in or what to do when it is missing.
 *
 * Always scoped by organizationId. An unknown organization resolves to the
 * same default the column carries rather than throwing — a request whose
 * office row cannot be read must still behave, and behaving means the
 * pre-existing three days, never zero.
 */
export async function loadHumanReviewAfterDays(organizationId: string): Promise<number> {
  const db = await getDb();
  const [organization] = await db
    .select({ humanReviewAfterDays: organizations.humanReviewAfterDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return resolveHumanReviewAfterDays(organization?.humanReviewAfterDays);
}
