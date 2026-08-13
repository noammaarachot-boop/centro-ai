import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { decryptToken, encryptToken } from "./tokenCipher";
import { refreshAccessToken, revokeToken, type TokenSet } from "./oauthClient";

// Refresh proactively once fewer than this many ms remain — comfortably
// covers the time a single request/Drive call takes, so a caller never
// hands out a token that expires mid-flight.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class GoogleNotConnectedError extends Error {
  constructor() {
    super("This organization has not connected a Google account.");
  }
}

export async function storeTokens(organizationId: string, tokens: TokenSet): Promise<void> {
  const db = await getDb();

  // A token refresh response never repeats refresh_token — if this call
  // is itself the result of a refresh (tokens.refreshToken is null),
  // preserve whatever refresh token is already stored instead of wiping
  // it out.
  const existingRefreshTokenEnc = tokens.refreshToken
    ? null
    : (
        await db
          .select({ googleRefreshTokenEnc: organizations.googleRefreshTokenEnc })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1)
      )[0]?.googleRefreshTokenEnc ?? null;

  await db
    .update(organizations)
    .set({
      googleAccessTokenEnc: encryptToken(tokens.accessToken),
      googleRefreshTokenEnc: tokens.refreshToken
        ? encryptToken(tokens.refreshToken)
        : existingRefreshTokenEnc,
      googleTokenExpiresAt: tokens.expiresAt,
      googleConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}

// Returns a currently-valid access token, transparently refreshing (and
// persisting the refreshed token) if the stored one is expired or close
// to it. Throws GoogleNotConnectedError if this organization never
// completed the OAuth flow.
export async function getValidAccessToken(organizationId: string): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({
      googleAccessTokenEnc: organizations.googleAccessTokenEnc,
      googleRefreshTokenEnc: organizations.googleRefreshTokenEnc,
      googleTokenExpiresAt: organizations.googleTokenExpiresAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!row?.googleAccessTokenEnc || !row.googleTokenExpiresAt) {
    throw new GoogleNotConnectedError();
  }

  const expiresInMs = row.googleTokenExpiresAt.getTime() - Date.now();
  if (expiresInMs > EXPIRY_BUFFER_MS) {
    return decryptToken(row.googleAccessTokenEnc);
  }

  if (!row.googleRefreshTokenEnc) {
    throw new GoogleNotConnectedError();
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(decryptToken(row.googleRefreshTokenEnc));
  } catch (error) {
    // Owner Dashboard System Health signal — previously this failure
    // only ever reached a console.error somewhere up the call stack.
    // Best-effort: a failure recording the failure must never mask the
    // original error, so this is caught and swallowed on its own.
    try {
      await recordAuditEvent({
        organizationId,
        eventType: "integration.google_token_refresh_failed",
        description: "רענון טוקן Google Drive נכשל",
        actorType: "system",
        metadata: { severity: "warning" },
      });
    } catch (auditError) {
      console.error("[owner-health] failed to record google_token_refresh_failed audit event", auditError);
    }
    throw error;
  }
  await storeTokens(organizationId, { ...refreshed, refreshToken: null });
  return refreshed.accessToken;
}

// Disconnect: best-effort revoke with Google, then clear every stored
// credential and the selected folder — Centro must have nothing left to
// act on after this. "Best-effort" is honored literally: a stored token
// that can no longer be decrypted (e.g. GOOGLE_TOKEN_ENCRYPTION_KEY was
// rotated since it was saved) can never be revoked with Google either way
// — the local credentials must still be cleared so the organization can
// reconnect, rather than leaving an already-unusable connection stuck in
// place. This is reached ONLY from an explicit user-initiated Disconnect
// (see this function's own callers) — a routine token check elsewhere
// (getValidAccessToken above) never calls this and never deletes anything
// on its own failure.
export async function clearTokens(organizationId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({
      googleAccessTokenEnc: organizations.googleAccessTokenEnc,
      googleRefreshTokenEnc: organizations.googleRefreshTokenEnc,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const tokenToRevoke = row?.googleRefreshTokenEnc ?? row?.googleAccessTokenEnc;
  if (tokenToRevoke) {
    try {
      await revokeToken(decryptToken(tokenToRevoke));
    } catch (error) {
      console.error(
        "[google-drive] token revoke failed during explicit disconnect (clearing local credentials anyway)",
        error
      );
    }
  }

  await db
    .update(organizations)
    .set({
      googleConnectedAt: null,
      googleAccessTokenEnc: null,
      googleRefreshTokenEnc: null,
      googleTokenExpiresAt: null,
      googleDriveFolderId: null,
      googleDriveFolderName: null,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}
