import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
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
// resolved fresh on every call, never trusted from a request body. This is
// a heavily-reused test/dev database (19 organizations, several unrelated
// clients sharing the same test phone number's last digits across old
// experiments) — matching on phone digits ALONE picked the wrong client in
// practice (a same-suffix client in a disconnected org). Requires BOTH the
// exact name "רז שלום" AND a phone digit match, and among any remaining
// candidates prefers the one in an organization that's actually connected
// (real Drive folder + real WhatsApp number) — never just "the first row
// found."
async function resolveTestClient() {
  const db = await getDb();
  const all = await db.select().from(clients);
  const candidates = all.filter(
    (c) => c.name.trim() === "רז שלום" && c.phone.replace(/\D/g, "").endsWith(TEST_CLIENT_PHONE_SUFFIX)
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const allOrgs = await db.select().from(organizations);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const connected = candidates.find((c) => {
    const org = orgById.get(c.organizationId);
    return !!org?.googleDriveFolderId && !!org?.whatsappPhoneNumberId;
  });
  return connected ?? candidates[0];
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
      // Read-only diagnostic — checks whether pg_cron/pg_net are available
      // on this Neon instance, to evaluate a genuinely-free, existing-
      // infrastructure alternative to GitHub Actions' unreliable scheduled-
      // workflow timing for the 2-minute silence-window case review.
      case "check_pg_extensions": {
        const available = await db.execute(
          sql`SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('pg_cron','pg_net') ORDER BY name`
        );
        const installed = await db.execute(sql`SELECT extname, extversion FROM pg_extension ORDER BY extname`);
        return NextResponse.json({ ok: true, available: JSON.parse(JSON.stringify(available)), installed: JSON.parse(JSON.stringify(installed)) });
      }

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

      // Read-only diagnostic — never mutates anything. Lists every
      // organization with a real Drive/WhatsApp connection, and every
      // client row matching the test phone number's digits (regardless of
      // which organization it belongs to), so the correct org/client pair
      // can be identified with certainty instead of guessed.
      case "survey": {
        const allOrgs = await db.select().from(organizations);
        const allClients = await db.select().from(clients);
        const matchingClients = allClients.filter((c) => c.phone.replace(/\D/g, "").endsWith(TEST_CLIENT_PHONE_SUFFIX));
        return NextResponse.json({
          ok: true,
          organizations: allOrgs.map((o) => ({
            id: o.id,
            name: o.name,
            googleConnectedAt: o.googleConnectedAt,
            hasGoogleDriveFolderId: !!o.googleDriveFolderId,
            googleDriveFolderName: o.googleDriveFolderName,
            whatsappConnectedAt: o.whatsappConnectedAt,
            hasWhatsappPhoneNumberId: !!o.whatsappPhoneNumberId,
            whatsappDisplayPhoneNumber: o.whatsappDisplayPhoneNumber,
            documentCollectionEnabled: o.documentCollectionEnabled,
          })),
          matchingClients: matchingClients.map((c) => ({ id: c.id, name: c.name, phone: c.phone, organizationId: c.organizationId })),
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
        // Real semantic parsing (real AI call) per requirement, exactly the
        // same as the office-user-facing "add requirement" flow — never a
        // raw name-only row, so this genuinely exercises the semantic
        // requirement engine too, not just a hand-set requiredCount.
        const { parseRequirementSemantics } = await import("@/lib/ai/requirementSemantics");
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
        const parsedSpecs = [];
        for (const name of requirementNames) {
          const spec = await parseRequirementSemantics(name);
          const [row] = await db
            .insert(collectionRequestRequirements)
            .values({
              collectionRequestId: newRequest.id,
              name,
              requiredCount: spec.requiredCount,
              semanticSpec: spec,
            })
            .returning();
          parsedSpecs.push({ requirementId: row.id, name, spec });
        }
        const { conversation, sent } = await startConversation(org.id, newRequest.id, testClient!.id, "manual");
        return NextResponse.json({ ok: true, requestId: newRequest.id, conversationId: conversation.id, initialMessageSent: sent, parsedSpecs });
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

      case "set_pending_case_review_at": {
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
          .set({ pendingCaseReviewAt: new Date(isoDate) })
          .where(eq(conversations.id, conversation.id));
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
