import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { exchangeSignupCode, subscribeToWabaWebhooks, WhatsAppSignupError } from "@/lib/whatsapp/embeddedSignup";
import { getPhoneNumberDetails, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import { storeWabaConnection } from "@/lib/whatsapp/wabaTokens";

export const dynamic = "force-dynamic";

// Entry point for WhatsAppConnectButton's client-side Embedded Signup —
// a fetch() POST once FB.login() and the WA_EMBEDDED_SIGNUP postMessage
// both resolve, not a redirect. Unlike Google's callback (a real
// full-page navigation back from accounts.google.com), Embedded Signup
// stays inside a popup the whole time, so this just returns JSON for the
// client component to react to.
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const { code, wabaId, phoneNumberId } = body as {
    code?: unknown;
    wabaId?: unknown;
    phoneNumberId?: unknown;
  };
  if (
    typeof code !== "string" ||
    !code ||
    typeof wabaId !== "string" ||
    !wabaId ||
    typeof phoneNumberId !== "string" ||
    !phoneNumberId
  ) {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  try {
    await exchangeSignupCode(code);
    await subscribeToWabaWebhooks(wabaId);
    const details = await getPhoneNumberDetails(phoneNumberId);

    await storeWabaConnection(session.organizationId, {
      businessAccountId: wabaId,
      phoneNumberId: details.id,
      displayPhoneNumber: details.displayPhoneNumber,
      verifiedName: details.verifiedName,
    });

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "integration.whatsapp_connected",
      description: `חשבון WhatsApp Business חובר (${details.displayPhoneNumber})`,
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
