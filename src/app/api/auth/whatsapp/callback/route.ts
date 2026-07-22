import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import {
  exchangeSignupCode,
  resolveWabaIdFromToken,
  subscribeToWabaWebhooks,
  WhatsAppSignupError,
} from "@/lib/whatsapp/embeddedSignup";
import { getFirstPhoneNumberForWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import { storeWabaConnection } from "@/lib/whatsapp/wabaTokens";

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
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const { code } = body as { code?: unknown };
  if (typeof code !== "string" || !code) {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  try {
    const userAccessToken = await exchangeSignupCode(code);
    const wabaId = await resolveWabaIdFromToken(userAccessToken);
    await subscribeToWabaWebhooks(wabaId);
    const phoneNumber = await getFirstPhoneNumberForWaba(wabaId);

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
  } catch (error) {
    console.error("[whatsapp-oauth] Embedded Signup completion failed", error);
    const knownFailure = error instanceof WhatsAppSignupError || error instanceof WhatsAppApiError;
    return NextResponse.json(
      { error: knownFailure ? "whatsapp-signup-failed" : "whatsapp-unknown-error" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
