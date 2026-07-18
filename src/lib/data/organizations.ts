import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";

export async function getOrganization(organizationId: string) {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return organization ?? null;
}
