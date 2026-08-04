import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { GRAPH_API_VERSION } from "@/lib/whatsapp/config";
import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
} from "@/lib/whatsapp/hardcodedConfig";
import { WHATSAPP_OAUTH_CALLBACK_URI } from "@/lib/whatsapp/embeddedSignup";
import {
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_STATE_COOKIE,
  cleanWhatsAppReturnTo,
  encodeWhatsAppOAuthState,
} from "@/lib/whatsapp/oauthState";

export const dynamic = "force-dynamic";

export {
  WHATSAPP_OAUTH_STATE_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
} from "@/lib/whatsapp/oauthState";

const DEFAULT_RETURN_TO = "/settings";
const POPUP_COOKIE = "whatsapp_oauth_popup";

function resolveReturnTo(raw: string | null): string {
  if (!raw) return DEFAULT_RETURN_TO;
  const cleaned = cleanWhatsAppReturnTo(raw);
  if (
    cleaned.startsWith("/collections/") ||
    cleaned.startsWith("/settings") ||
    cleaned.startsWith("/onboarding")
  ) {
    return cleaned;
  }
  return DEFAULT_RETURN_TO;
}

function resolveRedirectUri(): string {
  if (WHATSAPP_HARDCODE_ENABLED) {
    return WHATSAPP_HARDCODED.oauthCallbackUri;
  }
  const fromEnv = process.env.WHATSAPP_OAUTH_REDIRECT_URI?.trim();
  if (fromEnv && /^https:\/\//i.test(fromEnv) && !fromEnv.includes("?")) {
    return fromEnv;
  }
  return WHATSAPP_OAUTH_CALLBACK_URI;
}

// Full-page or popup Facebook Login for Business dialog with fixed redirect_uri.
// Popup mode: ?popup=1 — opened via window.open from WhatsAppConnectButton.
export async function GET(request: NextRequest) {
  await requireSession();

  const appId = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.appId
    : process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
  const configId = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.configId
    : process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  const { searchParams } = new URL(request.url);
  const returnTo = resolveReturnTo(searchParams.get("returnTo"));
  const popup = searchParams.get("popup") === "1";
  const errorPath = buildFailRedirect(returnTo, "whatsapp-not-configured");
  const redirectUri = resolveRedirectUri();

  if (!appId || !configId) {
    console.error("[whatsapp-oauth] start missing NEXT_PUBLIC_WHATSAPP_APP_ID or CONFIG_ID");
    return NextResponse.redirect(new URL(errorPath, request.url));
  }

  if (searchParams.get("debug") === "1") {
    return NextResponse.json({
      appId,
      configId,
      redirectUri,
      mustMatchExactlyInMeta: redirectUri,
      returnTo,
      popup,
    });
  }

  const csrf = randomUUID();
  const state = encodeWhatsAppOAuthState({
    csrf,
    returnTo,
    redirectUri,
    exp: Date.now() + 10 * 60 * 1000,
    popup,
  });

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
    popup,
  });

  const response = NextResponse.redirect(dialogUrl);
  const cookieBase = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  response.cookies.set(WHATSAPP_OAUTH_STATE_COOKIE, csrf, cookieBase);
  response.cookies.set(WHATSAPP_OAUTH_RETURN_TO_COOKIE, returnTo, cookieBase);
  response.cookies.set(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE, redirectUri, cookieBase);
  if (popup) {
    response.cookies.set(POPUP_COOKIE, "1", cookieBase);
  } else {
    response.cookies.delete(POPUP_COOKIE);
  }
  return response;
}

function buildFailRedirect(returnTo: string, code: string): string {
  const url = new URL(cleanWhatsAppReturnTo(returnTo), "https://www.centro-ai.co.il");
  url.searchParams.set("error", code);
  return `${url.pathname}?${url.searchParams.toString()}`;
}
