/**
 * One-off, idempotent cleanup, run in two passes for every client of every
 * Drive-connected organization:
 *
 *  1. mergeDuplicateClientFolders(clientId, rootFolderId) — resolves any
 *     leftover duplicate folder directly under the org root (from the
 *     pre-locking race in the very first version of the folder-resolution
 *     logic) down to one.
 *  2. relocateLegacyClientFolder(clientId) — moves that single flat
 *     root-level folder under the correct "<Hebrew month> <year>" folder
 *     (computed from the client's most recent collection request that
 *     hasn't resolved its own driveClientFolderId yet), completing the
 *     move to the new <root>/<month>/<client>/<documents> structure.
 *
 * Safe to run more than once — a client with nothing to merge or relocate
 * is a no-op in both passes.
 *
 * Wired into the build for exactly one deploy (see package.json) rather
 * than run ad hoc, for the same reason as db:migrate: the real, decrypted
 * DATABASE_URL and Google OAuth credentials only exist in Vercel's
 * build/runtime environment, never retrievable locally (DATABASE_URL is
 * marked Sensitive). Remove the build wiring once this has run once
 * successfully in production — this is a cleanup pass, not a per-deploy
 * step. Always exits 0 (see main() below) so it can never block a deploy.
 */
import { isNotNull, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { clients, organizations } from "../src/db/schema";
import { mergeDuplicateClientFolders, relocateLegacyClientFolder } from "../src/lib/storage/driveAdapter";

async function main() {
  const db = await getDb();
  const connectedOrgs = await db
    .select({ id: organizations.id, name: organizations.name, rootFolderId: organizations.googleDriveFolderId })
    .from(organizations)
    .where(isNotNull(organizations.googleDriveFolderId));

  let clientsProcessed = 0;
  let duplicatesMerged = 0;
  let filesMoved = 0;
  let relocated = 0;
  let failures = 0;

  for (const org of connectedOrgs) {
    if (!org.rootFolderId) continue;
    const orgClients = await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.organizationId, org.id));

    for (const client of orgClients) {
      try {
        const mergeResult = await mergeDuplicateClientFolders(client.id, org.rootFolderId);
        clientsProcessed += 1;
        duplicatesMerged += mergeResult.duplicatesMerged;
        filesMoved += mergeResult.filesMoved;
        if (mergeResult.duplicatesMerged > 0) {
          console.log(
            `[fix-drive-folders] merged org="${org.name}" client="${client.name}" (${client.id}) -> primary=${mergeResult.primaryFolderId} duplicatesMerged=${mergeResult.duplicatesMerged} filesMoved=${mergeResult.filesMoved}`
          );
        }

        const relocateResult = await relocateLegacyClientFolder(client.id);
        if (relocateResult.relocated) {
          relocated += 1;
          console.log(
            `[fix-drive-folders] relocated org="${org.name}" client="${client.name}" (${client.id}) -> month=${relocateResult.monthFolderId} folder=${relocateResult.clientFolderId} request=${relocateResult.collectionRequestId}`
          );
        }
      } catch (error) {
        failures += 1;
        // Never let one client's failure abort the run for every other
        // client/org — same principle as ensureTemplatesProvisioned's
        // per-template isolation elsewhere in this codebase.
        console.error(`[fix-drive-folders] FAILED org="${org.name}" client="${client.name}" (${client.id})`, error);
      }
    }
  }

  console.log(
    `[fix-drive-folders] done: ${clientsProcessed} client(s) processed, ${duplicatesMerged} duplicate folder(s) merged, ${filesMoved} file(s) moved, ${relocated} folder(s) relocated into month structure, ${failures} failure(s)`
  );
  // Always exits 0, even with per-client failures (already logged above in
  // full) — a stale token or transient Drive error for one client must
  // never block the deploy that ships the actual code fix for everyone
  // else. This script is a best-effort cleanup pass, not a build gate.
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // Only reaches here for something outside the per-client try/catch
    // (e.g. the database itself unreachable) — still doesn't fail the
    // build; the code fix shipping matters more than this cleanup pass.
    console.error("[fix-drive-folders] fatal (non-blocking)", error);
    process.exit(0);
  });
