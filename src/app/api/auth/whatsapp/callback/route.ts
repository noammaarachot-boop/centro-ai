import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import {
  exchangeSignupCode,
  resolveWabaIdFromToken,
  subscribeToWabaWebhooks,
  WhatsAppSignupError,
  type WhatsAppSignupStep,
} from "@/lib/whatsapp/embeddedSignup";
import { getFirstPhoneNumberForWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import { storeWabaConnection } from "@/lib/whatsapp/wabaTokens";
import { ensureTemplatesProvisioned } from "@/lib/whatsapp/templates";

export const dynamic = "force-dynamic";

// Entry point for WhatsAppConnectButton's client-side Embedded Signup —
// a fetch() POST once FB.login() resolves with an authorization code.
// Not a redirect, unlike Google's callback: Embedded Signup stays inside
// a popup the whole time, so this just returns JSON for the client
// component to react to.
//
// Originally also expected wabaId/phoneNumberId reported by Meta's
// WA_EMBEDDED_SIGNUP postMessage, but that channel was confirmed — after
// extensive live testing, including a correctly-configured `extras`
// param on FB.login() — to never fire for this app/configuration. Both
// are now derived entirely server-side from the exchanged code itself:
// debug_token's granular_scopes reveals which WABA the signup granted
// access to (resolveWabaIdFromToken), and that WABA's own /phone_numbers
// listing supplies the connected number (getFirstPhoneNumberForWaba).
//
// Post-signup order (deliberate):
//   1. exchange code → user access token
//   2. resolve WABA from that token
//   3. list phone numbers (user token first, System User fallback)
//   4. store connection — must succeed for "connected" UX
//   5. webhook subscribe (best-effort; must not undo a saved connection)
//   6. template provisioning (best-effort, unchanged)
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const { code, redirectUri } = body as { code?: unknown; redirectUri?: unknown };
  if (typeof code !== "string" || !code) {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }
  // Optional: page origin from the browser that ran FB.login() — Meta may
  // require this exact redirect_uri on exchange when Valid OAuth Redirect
  // URIs is set. Must match a listed URI byte-for-byte when used.
  const preferredRedirectUri =
    typeof redirectUri === "string" && redirectUri.trim() ? redirectUri.trim() : null;

  // Tracks the furthest step for WA-03 error responses / logs.
  let step: WhatsAppSignupStep = "code-exchange";

  try {
    step = "code-exchange";
    const userAccessToken = await exchangeSignupCode(code, preferredRedirectUri);

    step = "waba-resolve";
    const wabaId = await resolveWabaIdFromToken(userAccessToken);

    // WA-01: pass the user token so phone listing works before System User
    // asset sharing catches up.
    step = "phone-lookup";
    const phoneNumber = await getFirstPhoneNumberForWaba(wabaId, userAccessToken);

    step = "store";
    await storeWabaConnection(session.organizationId, {
      businessAccountId: wabaId,
      phoneNumberId: phoneNumber.id,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
      verifiedName: phoneNumber.verifiedName,
    });

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "integration.whatsapp_connected",
      description: `חשבון WhatsApp Business חובר (${phoneNumber.displayPhoneNumber})`,
      actorType: "employee",
      actorUserId: session.userId,
    });

    // WA-02: after the connection is stored, webhooks are best-effort.
    // A System User / share lag must not reverse a successful connect.
    step = "webhook-subscribe";
    const webhooksOk = await subscribeToWabaWebhooks(wabaId, userAccessToken);
    if (!webhooksOk) {
      console.error(
        `[whatsapp-oauth] connection stored for org=${session.organizationId} waba=${wabaId}, but WABA webhook subscription failed (non-fatal; inbound messages may not arrive until reconnect)`
      );
    }

    // Best-effort template provisioning — same non-fatal policy as before.
    try {
      await ensureTemplatesProvisioned(wabaId);
    } catch (error) {
      console.error("[whatsapp-oauth] template auto-provisioning failed (non-fatal)", error);
    }

    return NextResponse.json({ ok: true, webhooksSubscribed: webhooksOk });
  } catch (error) {
    const knownStep =
      error instanceof WhatsAppSignupError
        ? error.step
        : error instanceof WhatsAppApiError
          ? error.step
          : step;
    const knownFailure = error instanceof WhatsAppSignupError || error instanceof WhatsAppApiError;

    console.error(
      `[whatsapp-oauth] Embedded Signup completion failed at step=${knownStep}`,
      error
    );

    // WA-03: return a safe step id + Meta error fields (no secrets) so
    // live diagnosis works from the browser when Vercel logs are unavailable.
    const publicMeta = error instanceof WhatsAppSignupError ? error.publicMeta : undefined;
    return NextResponse.json(
      {
        error: knownFailure ? "whatsapp-signup-failed" : "whatsapp-unknown-error",
        step: knownStep,
        ...(publicMeta ? { meta: publicMeta } : {}),
      },
      { status: 502 }
    );
  }
}
