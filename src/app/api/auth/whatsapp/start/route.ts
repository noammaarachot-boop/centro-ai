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

function resolveRedirectUri(): string {
  // Whatever is set on Vercel must be listed byte-for-byte in Meta Valid
  // OAuth Redirect URIs for App ID NEXT_PUBLIC_WHATSAPP_APP_ID.
  const fromEnv = process.env.WHATSAPP_OAUTH_REDIRECT_URI?.trim();
  if (fromEnv && /^https:\/\//i.test(fromEnv) && !fromEnv.includes("?")) {
    return fromEnv;
  }
  return WHATSAPP_OAUTH_CALLBACK_URI;
}

// Full-page Facebook Login for Business dialog with an explicit redirect_uri
// we control. Unlike FB.login(), Meta then requires the same URI on code
// exchange — eliminating 36008/191 from opaque JS SDK popup redirects.
//
// Requires Valid OAuth Redirect URIs to include that exact redirect_uri
// (default: https://www.centro-ai.co.il/api/auth/whatsapp/oauth)
// under the same Meta App ID as NEXT_PUBLIC_WHATSAPP_APP_ID.
export async function GET(request: NextRequest) {
  await requireSession();

  const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
  const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  const { searchParams } = new URL(request.url);
  const returnTo = resolveReturnTo(searchParams.get("returnTo"));
  const errorSeparator = returnTo.includes("?") ? "&" : "?";
  const redirectUri = resolveRedirectUri();

  if (!appId || !configId) {
    console.error("[whatsapp-oauth] start missing NEXT_PUBLIC_WHATSAPP_APP_ID or CONFIG_ID");
    return NextResponse.redirect(
      new URL(`${returnTo}${errorSeparator}error=whatsapp-not-configured`, request.url)
    );
  }

  // Compare Meta dashboard ↔ this payload. Open while logged in:
  //   /api/auth/whatsapp/start?debug=1
  if (searchParams.get("debug") === "1") {
    return NextResponse.json({
      appId,
      configId,
      redirectUri,
      mustMatchExactlyInMeta: redirectUri,
      checklist: [
        "Meta App Dashboard top-left App ID must equal appId above",
        "Products → Facebook Login for Business → Settings → Valid OAuth Redirect URIs must include redirectUri (exact, including /)",
        "Also add the same URI under Products → Facebook Login → Settings if that product exists",
        "Client OAuth Login = Yes, Web OAuth Login = Yes, Enforce HTTPS = Yes",
        "App Domains include centro-ai.co.il and www.centro-ai.co.il",
        "Settings → Basic → Website platform Site URL = https://www.centro-ai.co.il/",
        "After Save, wait 1–2 min, hard-refresh, try Connect again",
        "On the Facebook error page, inspect the address bar for redirect_uri= and compare to redirectUri above",
      ],
      vercelHint:
        "Set WHATSAPP_OAUTH_REDIRECT_URI on Vercel to the same string you paste in Meta (or leave unset to use the default oauth callback).",
    });
  }

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
    appId,
    redirectUri,
    returnTo,
    configId,
  });
  return NextResponse.redirect(dialogUrl);
}
