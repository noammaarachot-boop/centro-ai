import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getWhatsAppConfig, GRAPH_API_BASE, GRAPH_API_VERSION } from "@/lib/whatsapp/config";
import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
} from "@/lib/whatsapp/hardcodedConfig";

export const dynamic = "force-dynamic";

// Phase 7 remediation — matches the timeout already applied to every other
// outbound Meta Graph API call in src/lib/whatsapp/send.ts (15s).
const GRAPH_DEBUG_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Session-protected diagnosis of WhatsApp/Meta wiring.
 * Never returns secrets. Open while logged into Centro:
 *   GET /api/auth/whatsapp/debug-config
 *
 * Verifies that WHATSAPP_APP_SECRET matches hardcoded App ID via Graph
 * (app-id|app-secret as app access token). A secret for a different app
 * often looks like "settings are fine" in the wrong dashboard while
 * exchange still returns 191/36008.
 */
export async function GET() {
  await requireSession();

  let appId = "";
  let oauthRedirectUri: string | null = null;
  let secretPresent = false;
  let tokenPresent = false;
  let secretFrom: "hardcodedConfig" | "env" | "missing" = "missing";

  try {
    const cfg = getWhatsAppConfig();
    appId = cfg.appId;
    oauthRedirectUri = cfg.oauthRedirectUri;
    secretPresent = !!cfg.appSecret;
    tokenPresent = !!cfg.systemUserToken;
    secretFrom =
      WHATSAPP_HARDCODE_ENABLED && WHATSAPP_HARDCODED.appSecret
        ? "hardcodedConfig"
        : process.env.WHATSAPP_APP_SECRET
          ? "env"
          : "missing";
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        hardcodeEnabled: WHATSAPP_HARDCODE_ENABLED,
        expectedAppId: WHATSAPP_HARDCODED.appId,
      },
      { status: 500 }
    );
  }

  // Prove secret belongs to this App ID without ever returning the secret.
  let graphAppCheck: {
    ok: boolean;
    status: number;
    appName?: string;
    appIdReturned?: string;
    errorMessage?: string;
  } = { ok: false, status: 0 };

  try {
    const { appSecret } = getWhatsAppConfig();
    const params = new URLSearchParams({
      fields: "id,name",
      access_token: `${appId}|${appSecret}`,
    });
    const res = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(appId)}?${params}`, {
      signal: AbortSignal.timeout(GRAPH_DEBUG_REQUEST_TIMEOUT_MS),
    });
    const bodyText = await res.text();
    graphAppCheck.status = res.status;
    if (res.ok) {
      const json = JSON.parse(bodyText) as { id?: string; name?: string };
      graphAppCheck = {
        ok: true,
        status: res.status,
        appName: json.name,
        appIdReturned: json.id,
      };
    } else {
      let errorMessage = bodyText.slice(0, 400);
      try {
        const json = JSON.parse(bodyText) as { error?: { message?: string } };
        errorMessage = json.error?.message ?? errorMessage;
      } catch {
        // keep text
      }
      graphAppCheck = { ok: false, status: res.status, errorMessage };
    }
  } catch (error) {
    graphAppCheck = {
      ok: false,
      status: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  return NextResponse.json({
    ok: graphAppCheck.ok,
    hardcodeEnabled: WHATSAPP_HARDCODE_ENABLED,
    graphVersion: GRAPH_API_VERSION,
    using: {
      appId,
      configId: WHATSAPP_HARDCODED.configId,
      oauthRedirectUri,
      siteOriginTrailing: WHATSAPP_HARDCODED.siteOriginTrailing,
      oauthCallbackUri: WHATSAPP_HARDCODED.oauthCallbackUri,
      secretPresent,
      secretFrom,
      systemUserTokenPresent: tokenPresent,
    },
    graphAppLookup: graphAppCheck,
    metaChecklistIfStill191: [
      "Confirm you edited App ID " + appId + " (URL must contain this number)",
      "Settings → Basic → App Domains (no https): centro-ai.co.il AND www.centro-ai.co.il",
      "Add Platform → Website → Site URL exactly https://www.centro-ai.co.il/",
      "Facebook Login for Business → Settings → Valid OAuth Redirect URIs include https://www.centro-ai.co.il/",
      "Allowed Domains for the JavaScript SDK includes centro-ai.co.il / www",
      "Login with the JavaScript SDK = Yes, Client OAuth = Yes, Web OAuth = Yes",
      "If graphAppLookup.ok is false: WHATSAPP_APP_SECRET is wrong for this App ID (fix Vercel secret, re-copy from App Settings → Basic → App Secret)",
    ],
  });
}
