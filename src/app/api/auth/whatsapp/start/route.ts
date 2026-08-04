import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { GRAPH_API_VERSION } from "@/lib/whatsapp/config";
import { WHATSAPP_OAUTH_CALLBACK_URI } from "@/lib/whatsapp/embeddedSignup";

export const dynamic = "force-dynamic";

export const WHATSAPP_OAUTH_STATE_COOKIE = "whatsapp_oauth_state";
export const WHATSAPP_OAUTH_RETURN_TO_COOKIE = "whatsapp_oauth_return_to";
export const WHATSAPP_OAUTH_REDIRECT_URI_COOKIE = "whatsapp_oauth_redirect_uri";

const DEFAULT_RETURN_TO = "/settings";

// Same-origin relative paths only — Open Redirect safe.
function resolveReturnTo(raw: string | null): string {
  if (!raw) return DEFAULT_RETURN_TO;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) {
    return DEFAULT_RETURN_TO;
  }
  // Known app surfaces that host the connect button.
  if (
    raw.startsWith("/collections/") ||
    raw.startsWith("/settings") ||
    raw.startsWith("/onboarding")
  ) {
    return raw;
  }
  return DEFAULT_RETURN_TO;
}

// Full-page Facebook Login for Business dialog with an explicit redirect_uri
// we control. Unlike FB.login(), Meta then requires the same URI on code
// exchange — eliminating 36008/191 from opaque JS SDK popup redirects.
//
// Requires Valid OAuth Redirect URIs to include:
//   https://www.centro-ai.co.il/api/auth/whatsapp/oauth
export async function GET(request: NextRequest) {
  await requireSession();

  const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
  const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  const { searchParams } = new URL(request.url);
  const returnTo = resolveReturnTo(searchParams.get("returnTo"));
  const errorSeparator = returnTo.includes("?") ? "&" : "?";

  if (!appId || !configId) {
    console.error("[whatsapp-oauth] start missing NEXT_PUBLIC_WHATSAPP_APP_ID or CONFIG_ID");
    return NextResponse.redirect(
      new URL(`${returnTo}${errorSeparator}error=whatsapp-not-configured`, request.url)
    );
  }

  // Prefer production callback when env points at it; else fixed const.
  // Must match cookie + exchange + Meta dashboard exactly.
  const envRedirect = process.env.WHATSAPP_OAUTH_REDIRECT_URI?.trim();
  const redirectUri =
    envRedirect && /\/api\/auth\/whatsapp\/oauth\/?$/i.test(envRedirect)
      ? envRedirect
      : WHATSAPP_OAUTH_CALLBACK_URI;

  const state = randomUUID();
  const cookieStore = await cookies();
  const cookieBase = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  cookieStore.set(WHATSAPP_OAUTH_STATE_COOKIE, state, cookieBase);
  cookieStore.set(WHATSAPP_OAUTH_RETURN_TO_COOKIE, returnTo, cookieBase);
  cookieStore.set(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE, redirectUri, cookieBase);

  // Match previous FB.login extras so Meta still treats this as Embedded Signup.
  const extras = JSON.stringify({
    setup: {},
    featureType: "",
    sessionInfoVersion: "3",
  });

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    config_id: configId,
    override_default_response_type: "true",
    extras,
  });

  const dialogUrl = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
  console.log("[whatsapp-oauth] starting dialog/oauth", {
    redirectUri,
    returnTo,
    configId,
  });
  return NextResponse.redirect(dialogUrl);
}
