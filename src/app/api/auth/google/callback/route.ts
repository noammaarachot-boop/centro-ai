import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { exchangeCodeForTokens } from "@/lib/googleAuth/oauthClient";
import { storeTokens } from "@/lib/googleAuth/driveTokens";
import { GOOGLE_OAUTH_STATE_COOKIE } from "../start/route";

export const dynamic = "force-dynamic";

// Google Drive is always connected from onboarding step 5 (Step3Connect,
// shared by both workflows — see src/app/onboarding/page.tsx) today, so
// a fixed return path is correct; there is no other entry point yet.
const RETURN_PATH = "/onboarding?step=5";

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GOOGLE_OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(GOOGLE_OAUTH_STATE_COOKIE);

  const googleError = searchParams.get("error");
  if (googleError) {
    // The user declined consent, or Google itself rejected the request —
    // either way, nothing to exchange.
    return NextResponse.redirect(new URL(`${RETURN_PATH}&error=google-denied`, request.url));
  }

  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    return NextResponse.redirect(new URL(`${RETURN_PATH}&error=google-invalid-state`, request.url));
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
    return NextResponse.redirect(new URL(`${RETURN_PATH}&error=google-oauth-failed`, request.url));
  }

  return NextResponse.redirect(new URL(RETURN_PATH, request.url));
}
