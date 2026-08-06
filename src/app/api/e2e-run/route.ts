import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  clients,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
  messages,
  organizations,
  pendingConfirmations,
  services,
} from "@/db/schema";
import { startConversation } from "@/lib/conversationOrchestration";
import { runScheduledTasks } from "@/lib/scheduler";
import { resolveRequirementException, type RequirementExceptionDecision } from "@/lib/requirementException";
import { getValidAccessToken } from "@/lib/googleAuth/driveTokens";
import { trashDriveFolder } from "@/lib/googleAuth/drive";

/**
 * TEMPORARY, session-scoped diagnostic route for a real, live E2E pass
 * requested and explicitly authorized by the account owner — never part of
 * the product's normal surface. Hard-scoped to exactly one designated test
 * client (055-9858685 / "רז שלום") so a bug here can never touch any other
 * organization's real data. Protected by E2E_RUN_SECRET (bearer token),
 * a freshly-generated value never derived from or overlapping with any
 * other credential. MUST be deleted, along with this file and the
 * E2E_RUN_SECRET env var, once the live test pass is complete — see the
 * session's own final report for confirmation this was done.
 */

export const dynamic = "force-dynamic";

const TEST_CLIENT_PHONE_SUFFIX = "9858685"; // 055-9858685, the one authorized test number

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function checkAuth(request: Request): boolean {
  const secret = process.env.E2E_RUN_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// The one and only client this entire route is ever allowed to touch —
// resolved fresh on every call, never trusted from a request body. Matches
// by digits-only suffix so it's robust to however the phone happens to be
// formatted in the database (055-9858685, +972559858685, etc.).
async function resolveTestClient() {
  const db = await getDb();
  const all = await db.select().from(clients);
  return all.find((c) => c.phone.replace(/\D/g, "").endsWith(TEST_CLIENT_PHONE_SUFFIX)) ?? null;
}

export async function POST(request: Request) {
  if (!checkAuth(request)) return unauthorized();

  const db = await getDb();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action as string | undefined;

  const testClient = await resolveTestClient();
  if (!testClient && action !== "ping") {
    return NextResponse.json({ error: "test client (055-9858685) not found" }, { status: 404 });
  }

  try {
    switch (action) {
      case "ping": {
        const [org] = testClient
          ? await db.select().from(organizations).where(eq(organizations.id, testClient.organizationId))
          : [];
        return NextResponse.json({
          ok: true,
          testClientFound: !!testClient,
          clientId: testClient?.id ?? null,
          organizationId: testClient?.organizationId ?? null,
          orgHasWhatsApp: !!org?.whatsappPhoneNumberId,
          orgHasDrive: !!org?.googleDriveFolderId,
          documentCollectionEnabled: org?.documentCollectionEnabled ?? null,
        });
      }

      case "status": {
        const requests = await db
          .select()
          .from(collectionRequests)
          .where(eq(collectionRequests.clientId, testClient!.id))
          .orderBy(desc(collectionRequests.createdAt));
        const latest = requests[0] ?? null;
        if (!latest) return NextResponse.json({ ok: true, request: null });

        const requirements = await db
          .select()
          .from(collectionRequestRequirements)
          .where(eq(collectionRequestRequirements.collectionRequestId, latest.id));
        const docs = await db.select().from(documents).where(eq(documents.collectionRequestId, latest.id));
        const [conversation] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.collectionRequestId, latest.id));
        const openConfirmations = conversation
          ? await db
              .select()
              .from(pendingConfirmations)
              .where(and(eq(pendingConfirmations.collectionRequestId, latest.id), eq(pendingConfirmations.status, "pending")))
          : [];
        const recentMessages = conversation
          ? await db
              .select()
              .from(messages)
              .where(eq(messages.conversationId, conversation.id))
              .orderBy(desc(messages.createdAt))
              .limit(15)
          : [];

        return NextResponse.json({
          ok: true,
          request: latest,
          requirements,
          documents: docs,
          conversation,
          openConfirmations,
          recentMessages: recentMessages.reverse(),
        });
      }

      case "create_request": {
        const requirementNames = (body.requirementNames as string[] | undefined) ?? ["מסמך בדיקה"];
        const requiredCounts = (body.requiredCounts as number[] | undefined) ?? [];
        const [org] = await db.select().from(organizations).where(eq(organizations.id, testClient!.organizationId));
        let [service] = await db.select().from(services).where(eq(services.organizationId, org.id)).limit(1);
        if (!service) {
          [service] = await db.insert(services).values({ organizationId: org.id, name: "שירות בדיקת E2E" }).returning();
        }
        const [newRequest] = await db
          .insert(collectionRequests)
          .values({
            organizationId: org.id,
            clientId: testClient!.id,
            serviceId: service.id,
            periodLabel: `E2E ${new Date().toISOString().slice(0, 10)}`,
            status: "active",
          })
          .returning();
        for (let i = 0; i < requirementNames.length; i++) {
          await db.insert(collectionRequestRequirements).values({
            collectionRequestId: newRequest.id,
            name: requirementNames[i],
            requiredCount: requiredCounts[i] ?? 1,
          });
        }
        const { conversation, sent } = await startConversation(org.id, newRequest.id, testClient!.id, "manual");
        return NextResponse.json({ ok: true, requestId: newRequest.id, conversationId: conversation.id, initialMessageSent: sent });
      }

      case "set_deferred_reminder_at": {
        const isoDate = body.isoDate as string;
        const [latest] = await db
          .select()
          .from(collectionRequests)
          .where(eq(collectionRequests.clientId, testClient!.id))
          .orderBy(desc(collectionRequests.createdAt))
          .limit(1);
        if (!latest) return NextResponse.json({ error: "no request found" }, { status: 404 });
        const [conversation] = await db.select().from(conversations).where(eq(conversations.collectionRequestId, latest.id));
        await db
          .update(conversations)
          .set({ deferredReminderAt: new Date(isoDate), status: "waiting_for_client" })
          .where(eq(conversations.id, conversation.id));
        await db.update(collectionRequests).set({ status: "waiting_for_client" }).where(eq(collectionRequests.id, latest.id));
        return NextResponse.json({ ok: true });
      }

      case "run_scheduler": {
        const [latest] = await db
          .select()
          .from(collectionRequests)
          .where(eq(collectionRequests.clientId, testClient!.id))
          .orderBy(desc(collectionRequests.createdAt))
          .limit(1);
        const orgId = latest?.organizationId ?? testClient!.organizationId;
        const result = await runScheduledTasks(orgId);
        return NextResponse.json({ ok: true, result });
      }

      case "resolve_exception": {
        const requirementId = body.requirementId as string;
        const decision = body.decision as RequirementExceptionDecision;
        const alternativeText = body.alternativeText as string | undefined;
        const [org] = await db.select().from(organizations).where(eq(organizations.id, testClient!.organizationId));
        const result = await resolveRequirementException({ organizationId: org.id, requirementId, decision, alternativeText });
        return NextResponse.json({ ok: true, result });
      }

      case "cleanup": {
        const requests = await db
          .select()
          .from(collectionRequests)
          .where(eq(collectionRequests.clientId, testClient!.id));
        let driveFoldersTrashed = 0;
        try {
          const accessToken = await getValidAccessToken(testClient!.organizationId);
          // Each request already knows its own client Drive folder
          // (driveClientFolderId) — trash exactly those, deduplicated,
          // never any folder this route didn't itself create for this
          // exact test client.
          const folderIds = new Set(requests.map((r) => r.driveClientFolderId).filter((id): id is string => !!id));
          for (const folderId of folderIds) {
            await trashDriveFolder(accessToken, folderId).catch(() => {});
            driveFoldersTrashed += 1;
          }
        } catch (driveError) {
          console.error("[e2e-run] drive cleanup best-effort failed (non-fatal)", driveError);
        }

        for (const r of requests) {
          const [conversation] = await db.select().from(conversations).where(eq(conversations.collectionRequestId, r.id));
          if (conversation) {
            await db.delete(pendingConfirmations).where(eq(pendingConfirmations.collectionRequestId, r.id));
            await db.delete(messages).where(eq(messages.conversationId, conversation.id));
          }
          await db.delete(documents).where(eq(documents.collectionRequestId, r.id));
          await db.delete(collectionRequestRequirements).where(eq(collectionRequestRequirements.collectionRequestId, r.id));
          await db.delete(auditLogs).where(eq(auditLogs.collectionRequestId, r.id));
          if (conversation) await db.delete(conversations).where(eq(conversations.id, conversation.id));
          await db.delete(collectionRequests).where(eq(collectionRequests.id, r.id));
        }
        return NextResponse.json({ ok: true, requestsDeleted: requests.length, driveFoldersTrashed });
      }

      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("[e2e-run] action failed", { action, error });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
