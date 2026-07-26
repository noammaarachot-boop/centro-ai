import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, organizations } from "@/db/schema";

// Stage-by-stage onboarding drop-off — entirely derived from existing
// columns/existence checks, no new instrumentation. Each stage is a
// strict subset of the previous one by construction (an org can't
// complete onboarding without being registered, etc.), so the counts
// are directly comparable as a funnel.
export interface OwnerOnboardingFunnel {
  registered: number;
  completedOnboarding: number;
  connectedWhatsapp: number;
  connectedDrive: number;
  createdFirstRequest: number;
  completedFirstRequest: number;
}

export async function getOnboardingFunnel(): Promise<OwnerOnboardingFunnel> {
  const db = await getDb();

  const [{ count: registered }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations);

  const [{ count: completedOnboarding }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations)
    .where(sql`${organizations.onboardingCompletedAt} is not null`);

  const [{ count: connectedWhatsapp }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations)
    .where(sql`${organizations.whatsappConnectedAt} is not null`);

  const [{ count: connectedDrive }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations)
    .where(sql`${organizations.googleConnectedAt} is not null`);

  const [{ count: createdFirstRequest }] = await db
    .select({ count: sql<number>`count(distinct ${collectionRequests.organizationId})::int` })
    .from(collectionRequests);

  const [{ count: completedFirstRequest }] = await db
    .select({ count: sql<number>`count(distinct ${collectionRequests.organizationId})::int` })
    .from(collectionRequests)
    .where(sql`${collectionRequests.status} = 'completed'`);

  return {
    registered,
    completedOnboarding,
    connectedWhatsapp,
    connectedDrive,
    createdFirstRequest,
    completedFirstRequest,
  };
}
