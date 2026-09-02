import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, organizations, services } from "@/db/schema";
import { resolveScheduleConfig, type BusinessHoursConfig } from "@/lib/businessHours";
import { resolveHumanReviewAfterDays } from "@/lib/attention/policy";

/**
 * Everything needed to decide when a request needs a person: how many working
 * days the office allows, and which days those are.
 *
 * Kept apart from policy.ts so that module stays pure and directly testable;
 * this is the single tenant-scoped read, so no caller has to remember which
 * column the setting lives in, or how to work out when the office is open.
 *
 * The open days come from resolveScheduleConfig — the same function the
 * scheduler and every business-hours check already use, including a Service's
 * own override. Reading organizations.businessDays directly here would create
 * a second answer to "when is this business open", which is exactly the kind
 * of divergence this area has just finished removing.
 */
export interface HumanReviewPolicy {
  /** Working days a client may stay silent before the office is asked to act. */
  days: number;
  /** Which days those are, and the zone they are counted in. */
  schedule: BusinessHoursConfig;
}

const FALLBACK_SCHEDULE: BusinessHoursConfig = {
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  businessDays: "0,1,2,3,4",
  timezone: "Asia/Jerusalem",
};

const ORGANIZATION_FIELDS = {
  businessHoursStart: organizations.businessHoursStart,
  businessHoursEnd: organizations.businessHoursEnd,
  businessDays: organizations.businessDays,
  timezone: organizations.timezone,
  reminderIntervalHours: organizations.reminderIntervalHours,
  inactivityTimeoutMinutes: organizations.inactivityTimeoutMinutes,
  collectionDayOfMonth: organizations.collectionDayOfMonth,
  humanReviewAfterDays: organizations.humanReviewAfterDays,
} as const;

const SERVICE_OVERRIDES = {
  businessHoursStartOverride: services.businessHoursStartOverride,
  businessHoursEndOverride: services.businessHoursEndOverride,
  businessDaysOverride: services.businessDaysOverride,
  reminderIntervalHoursOverride: services.reminderIntervalHoursOverride,
  inactivityTimeoutMinutesOverride: services.inactivityTimeoutMinutesOverride,
  collectionDayOfMonthOverride: services.collectionDayOfMonthOverride,
} as const;

/**
 * The policy for one request, including its Service's own override.
 *
 * `collectionRequestId` is optional only because a couple of callers act on
 * an organization before any request exists; when it is supplied the Service
 * override is honored, exactly as the scheduler honors it.
 *
 * An unknown organization resolves to the shared defaults rather than
 * throwing — a request whose office row cannot be read must still behave, and
 * behaving means the pre-existing three working days, never zero.
 */
export async function loadHumanReviewPolicy(
  organizationId: string,
  collectionRequestId?: string
): Promise<HumanReviewPolicy> {
  const db = await getDb();

  if (collectionRequestId) {
    const [row] = await db
      .select({ organization: ORGANIZATION_FIELDS, service: SERVICE_OVERRIDES })
      .from(collectionRequests)
      .innerJoin(organizations, eq(organizations.id, collectionRequests.organizationId))
      .leftJoin(services, eq(services.id, collectionRequests.serviceId))
      // Scoped by BOTH: a request id from another tenant simply is not found,
      // and falls through to that organization's own defaults below.
      .where(
        and(
          eq(collectionRequests.id, collectionRequestId),
          eq(collectionRequests.organizationId, organizationId)
        )
      )
      .limit(1);
    if (row) {
      return {
        days: resolveHumanReviewAfterDays(row.organization.humanReviewAfterDays),
        schedule: resolveScheduleConfig(row.organization, row.service),
      };
    }
  }

  const [organization] = await db
    .select(ORGANIZATION_FIELDS)
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return {
    days: resolveHumanReviewAfterDays(organization?.humanReviewAfterDays),
    schedule: organization ? resolveScheduleConfig(organization, null) : FALLBACK_SCHEDULE,
  };
}
