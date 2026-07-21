import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { buildAuthorizationUrl } from "@/lib/googleAuth/oauthClient";
import { getGoogleOAuthConfig } from "@/lib/googleAuth/config";

export const dynamic = "force-dynamic";

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";

// Entry point for the "Connect Google Drive" button (Step3Connect.tsx) —
// a plain link to here, not a server action, since this has to end in a
// full-page redirect to accounts.google.com.
export async function GET(request: NextRequest) {
  await requireSession(); // redirects to /login if not authenticated

  try {
    getGoogleOAuthConfig();
  } catch (error) {
    console.error("[google-oauth] start route misconfigured", error);
    return NextResponse.redirect(new URL("/onboarding?step=5&error=google-not-configured", request.url));
  }

  // CSRF protection: a random value both sent to Google as `state` and
  // stashed in a short-lived httpOnly cookie, compared on callback.
  const state = randomUUID();
  const cookieStore = await cookies();
  cookieStore.set(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizationUrl(state));
}
