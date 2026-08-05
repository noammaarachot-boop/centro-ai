/**
 * One-off, idempotent cleanup: for every client of every Drive-connected
 * organization, resolves duplicate Google Drive folders left over from the
 * race in the pre-fix ensureClientFolder (two documents arriving close
 * together could each create their own folder before either write landed)
 * down to a single primary folder, moving every file into it, verifying
 * the move, then trashing the emptied duplicates. Also tags (or re-tags)
 * every client's surviving folder with the centroClientId property the new
 * ensureClientFolder relies on to recognize its own folder on sight,
 * including clients who only ever had one folder and never a duplicate.
 *
 * Safe to run more than once — a client with nothing to merge is a no-op.
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
import { mergeDuplicateClientFolders } from "../src/lib/storage/driveAdapter";

async function main() {
  const db = await getDb();
  const connectedOrgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(isNotNull(organizations.googleDriveFolderId));

  let clientsProcessed = 0;
  let totalDuplicatesMerged = 0;
  let totalFilesMoved = 0;
  let failures = 0;

  for (const org of connectedOrgs) {
    const orgClients = await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.organizationId, org.id));

    for (const client of orgClients) {
      try {
        const result = await mergeDuplicateClientFolders(client.id);
        clientsProcessed += 1;
        totalDuplicatesMerged += result.duplicatesMerged;
        totalFilesMoved += result.filesMoved;
        console.log(
          `[fix-drive-folders] org="${org.name}" client="${client.name}" (${client.id}) -> primary=${result.primaryFolderId} duplicatesMerged=${result.duplicatesMerged} filesMoved=${result.filesMoved}`
        );
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
    `[fix-drive-folders] done: ${clientsProcessed} client(s) processed, ${totalDuplicatesMerged} duplicate folder(s) merged, ${totalFilesMoved} file(s) moved, ${failures} failure(s)`
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
