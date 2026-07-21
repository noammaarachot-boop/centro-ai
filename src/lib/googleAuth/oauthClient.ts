import { withRetry } from "@/lib/resilience";
import { getGoogleOAuthConfig, GOOGLE_DRIVE_SCOPE } from "./config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

// access_type=offline + prompt=consent guarantees a refresh_token even if
// this organization authorized before (Google otherwise only issues one
// on the very first-ever consent for a given user+client pair).
export function buildAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = getGoogleOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await withRetry(() =>
    fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
  );
  const data = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google token request failed: ${data.error ?? response.status} ${data.error_description ?? ""}`.trim()
    );
  }
  return data;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();
  const data = await postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    })
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

// A refresh response never repeats the refresh_token — callers must keep
// using the one they already stored.
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const data = await postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    })
  );
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

// Best-effort — called on disconnect so a revoked connection can't still
// be used if the token were ever compromised. Never blocks disconnecting
// locally (Google being unreachable must not prevent a user from clearing
// their own stored credentials).
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch (error) {
    console.error("[google-oauth] token revocation failed (non-fatal)", error);
  }
}
