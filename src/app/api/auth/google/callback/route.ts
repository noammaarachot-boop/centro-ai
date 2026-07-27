import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { exchangeCodeForTokens } from "@/lib/googleAuth/oauthClient";
import { storeTokens } from "@/lib/googleAuth/driveTokens";
import { GOOGLE_OAUTH_RETURN_TO_COOKIE, GOOGLE_OAUTH_STATE_COOKIE } from "../start/route";

export const dynamic = "force-dynamic";

// Product Evolution M9 — Google Drive can now be (re)connected from
// Settings too (an expired/revoked token, or a disconnect, must have a way
// back without redoing onboarding), not only from onboarding's Step 5. The
// actual destination is whatever ../start/route.ts stashed in the
// returnTo cookie (already validated there against an allowlist) —
// defaulting to Step 5 only if that cookie is somehow missing.
const DEFAULT_RETURN_PATH = "/onboarding?step=5";

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GOOGLE_OAUTH_STATE_COOKIE)?.value;
  const RETURN_PATH = cookieStore.get(GOOGLE_OAUTH_RETURN_TO_COOKIE)?.value || DEFAULT_RETURN_PATH;
  cookieStore.delete(GOOGLE_OAUTH_STATE_COOKIE);
  cookieStore.delete(GOOGLE_OAUTH_RETURN_TO_COOKIE);

  const errorSeparator = RETURN_PATH.includes("?") ? "&" : "?";

  const googleError = searchParams.get("error");
  if (googleError) {
    // The user declined consent, or Google itself rejected the request —
    // either way, nothing to exchange.
    return NextResponse.redirect(new URL(`${RETURN_PATH}${errorSeparator}error=google-denied`, request.url));
  }

  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    return NextResponse.redirect(
      new URL(`${RETURN_PATH}${errorSeparator}error=google-invalid-state`, request.url)
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await storeTokens(session.organizationId, tokens);
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "integration.google_connected",
      description: "חשבון Google חובר",
      actorType: "employee",
      actorUserId: session.userId,
    });
  } catch (error) {
    console.error("[google-oauth] callback token exchange failed", error);
    return NextResponse.redirect(
      new URL(`${RETURN_PATH}${errorSeparator}error=google-oauth-failed`, request.url)
    );
  }

  return NextResponse.redirect(new URL(RETURN_PATH, request.url));
}
