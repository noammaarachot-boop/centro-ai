import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, organizations, users } from "@/db/schema";
import { buildPhoneNumberWebhookUrl } from "@/lib/whatsapp/webhookUrls";

// Every function here is intentionally cross-organization — the one place
// in the data layer that drops the organizationId scoping every other
// src/lib/data/*.ts function enforces. Callers (src/app/owner/**) are
// responsible for the requireOwnerSession() gate; these are plain reads
// with no auth logic of their own, matching this codebase's existing
// convention (see src/lib/data/auditLog.ts).

export interface OwnerOrganizationListRow {
  id: string;
  name: string;
  workflowType: "recurring" | "one_time" | "on_demand" | "both";
  onboardingCompletedAt: Date | null;
  whatsappConnectedAt: Date | null;
  googleConnectedAt: Date | null;
  suspendedAt: Date | null;
  qaModeEnabledAt: Date | null;
  initialRequestV2Approved: boolean;
  reminderV2Approved: boolean;
  createdAt: Date;
  userEmail: string | null;
  userPhone: string | null;
  userFullName: string | null;
}

// Today's data model is "one organization = one shared user" (BR-13.1),
// so a plain left join (rather than a subquery per org) is both correct
// and simple — see scripts/create-organization.ts / register()'s own
// one-row-each insert pattern. Search generalizes the existing
// searchClients() ILIKE pattern (src/lib/data/dashboard.ts) across
// organizations + users instead of being scoped to one organization.
export async function listOrganizations(query?: string): Promise<OwnerOrganizationListRow[]> {
  const db = await getDb();
  const trimmed = query?.trim();

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      workflowType: organizations.workflowType,
      onboardingCompletedAt: organizations.onboardingCompletedAt,
      whatsappConnectedAt: organizations.whatsappConnectedAt,
      googleConnectedAt: organizations.googleConnectedAt,
      suspendedAt: organizations.suspendedAt,
      qaModeEnabledAt: organizations.qaModeEnabledAt,
      initialRequestV2Approved: organizations.initialRequestV2Approved,
      reminderV2Approved: organizations.reminderV2Approved,
      createdAt: organizations.createdAt,
      userEmail: users.email,
      userPhone: users.phone,
      userFullName: users.fullName,
    })
    .from(organizations)
    .leftJoin(users, eq(users.organizationId, organizations.id))
    .where(
      trimmed
        ? sql`(${organizations.name} ilike ${`%${trimmed}%`} or ${users.email} ilike ${`%${trimmed}%`} or ${users.phone} ilike ${`%${trimmed}%`} or ${users.fullName} ilike ${`%${trimmed}%`})`
        : undefined
    )
    .orderBy(desc(organizations.createdAt))
    .limit(200);

  return rows;
}

export interface OwnerOrganizationOverview {
  id: string;
  name: string;
  workflowType: "recurring" | "one_time" | "on_demand" | "both";
  businessCategory: string;
  businessCategoryCustomLabel: string | null;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
  whatsappConnectedAt: Date | null;
  whatsappDisplayPhoneNumber: string | null;
  whatsappBusinessAccountId: string | null;
  whatsappPhoneNumberId: string | null;
  whatsappVerifiedName: string | null;
  // Never the encrypted value itself — a manual connection's own token
  // never leaves storeWabaConnection/decryptWhatsAppToken's own call
  // sites, not even encrypted, so the UI layer only ever gets to know
  // whether one exists.
  whatsappManuallyConnected: boolean;
  // Per-phone-number webhook override (Meta "Webhook overrides"). The
  // URL/token pair is surfaced whenever one exists, whether or not Meta
  // accepted the automatic registration — the dynamic route honours the
  // pair either way, so showing it is what lets the owner register the
  // override by hand in Meta when the automatic attempt didn't go through.
  // Unlike the Access Token, the verify token is surfaced deliberately: it
  // only proves the one-time hub.challenge handshake and grants no API
  // access. whatsappWebhookOverrideActive is the honest, separate answer
  // to "is Meta actually routing there yet".
  whatsappWebhookUrl: string | null;
  whatsappWebhookVerifyToken: string | null;
  whatsappWebhookOverrideActive: boolean;
  googleConnectedAt: Date | null;
  googleDriveFolderName: string | null;
  suspendedAt: Date | null;
  userEmail: string | null;
  userPhone: string | null;
  userFullName: string | null;
  clientCount: number;
  collectionRequestCount: number;
  openCollectionRequestCount: number;
}

const OPEN_COLLECTION_REQUEST_STATUSES = [
  "active",
  "waiting_for_client",
  "processing",
] as const;

export async function getOrganizationOverview(
  organizationId: string
): Promise<OwnerOrganizationOverview | null> {
  const db = await getDb();

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) return null;

  const [user] = await db
    .select({ email: users.email, phone: users.phone, fullName: users.fullName })
    .from(users)
    .where(eq(users.organizationId, organizationId))
    .limit(1);

  const [{ count: clientCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const [{ count: collectionRequestCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(eq(collectionRequests.organizationId, organizationId));

  const [{ count: openCollectionRequestCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        sql`${collectionRequests.status} in ${OPEN_COLLECTION_REQUEST_STATUSES}`
      )
    );

  return {
    id: org.id,
    name: org.name,
    workflowType: org.workflowType,
    businessCategory: org.businessCategory,
    businessCategoryCustomLabel: org.businessCategoryCustomLabel,
    onboardingCompletedAt: org.onboardingCompletedAt,
    createdAt: org.createdAt,
    whatsappConnectedAt: org.whatsappConnectedAt,
    whatsappDisplayPhoneNumber: org.whatsappDisplayPhoneNumber,
    whatsappBusinessAccountId: org.whatsappBusinessAccountId,
    whatsappPhoneNumberId: org.whatsappPhoneNumberId,
    whatsappVerifiedName: org.whatsappVerifiedName,
    whatsappManuallyConnected: !!org.whatsappAccessTokenEnc,
    whatsappWebhookUrl:
      org.whatsappWebhookVerifyToken && org.whatsappPhoneNumberId
        ? buildPhoneNumberWebhookUrl(org.whatsappPhoneNumberId)
        : null,
    whatsappWebhookVerifyToken: org.whatsappWebhookVerifyToken,
    whatsappWebhookOverrideActive: !!org.whatsappWebhookOverrideAt,
    googleConnectedAt: org.googleConnectedAt,
    googleDriveFolderName: org.googleDriveFolderName,
    suspendedAt: org.suspendedAt,
    userEmail: user?.email ?? null,
    userPhone: user?.phone ?? null,
    userFullName: user?.fullName ?? null,
    clientCount,
    collectionRequestCount,
    openCollectionRequestCount,
  };
}
