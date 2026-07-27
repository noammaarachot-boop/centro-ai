import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { buildAuthorizationUrl } from "@/lib/googleAuth/oauthClient";
import { getGoogleOAuthConfig } from "@/lib/googleAuth/config";

export const dynamic = "force-dynamic";

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_OAUTH_RETURN_TO_COOKIE = "google_oauth_return_to";

// Product Evolution M9 — Google Drive can now be (re)connected from
// Settings too, not only onboarding's Step 5 (see ../callback/route.ts's
// RETURN_PATH_ALLOWLIST). An allowlist, not an arbitrary redirect target,
// so this can never become an open-redirect vector via a crafted
// `?returnTo=`.
const DEFAULT_RETURN_TO = "/onboarding?step=5";
const RETURN_TO_ALLOWLIST = new Set([DEFAULT_RETURN_TO, "/settings"]);

// Entry point for the "Connect Google Drive" button (Step3Connect.tsx /
// Settings) — a plain link to here, not a server action, since this has to
// end in a full-page redirect to accounts.google.com.
export async function GET(request: NextRequest) {
  await requireSession(); // redirects to /login if not authenticated

  const { searchParams } = new URL(request.url);
  const requestedReturnTo = searchParams.get("returnTo");
  const returnTo =
    requestedReturnTo && RETURN_TO_ALLOWLIST.has(requestedReturnTo)
      ? requestedReturnTo
      : DEFAULT_RETURN_TO;

  const errorSeparator = returnTo.includes("?") ? "&" : "?";

  try {
    getGoogleOAuthConfig();
  } catch (error) {
    console.error("[google-oauth] start route misconfigured", error);
    return NextResponse.redirect(
      new URL(`${returnTo}${errorSeparator}error=google-not-configured`, request.url)
    );
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
  cookieStore.set(GOOGLE_OAUTH_RETURN_TO_COOKIE, returnTo, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizationUrl(state));
}
