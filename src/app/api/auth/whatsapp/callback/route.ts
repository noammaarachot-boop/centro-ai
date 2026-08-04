import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { completeWhatsAppSignup } from "@/lib/whatsapp/completeSignup";
import { WhatsAppSignupError } from "@/lib/whatsapp/embeddedSignup";
import { WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";

export const dynamic = "force-dynamic";

// Legacy JSON entry point for clients still using FB.login() + fetch.
// New UI uses GET /api/auth/whatsapp/start → dialog/oauth → /oauth.
export async function POST(request: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const { code, redirectUri, redirectUris } = body as {
    code?: unknown;
    redirectUri?: unknown;
    redirectUris?: unknown;
  };
  if (typeof code !== "string" || !code) {
    return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  }

  const preferredRedirectUris: string[] = [];
  if (typeof redirectUri === "string" && redirectUri.trim()) {
    preferredRedirectUris.push(redirectUri.trim());
  }
  if (Array.isArray(redirectUris)) {
    for (const item of redirectUris) {
      if (typeof item === "string" && item.trim()) preferredRedirectUris.push(item.trim());
    }
  }

  try {
    const result = await completeWhatsAppSignup({
      organizationId: session.organizationId,
      userId: session.userId,
      code,
      preferredRedirectUris,
    });
    return NextResponse.json({
      ok: true,
      webhooksSubscribed: result.webhooksSubscribed,
    });
  } catch (error) {
    const knownStep =
      error instanceof WhatsAppSignupError
        ? error.step
        : error instanceof WhatsAppApiError
          ? error.step
          : "unknown";
    const knownFailure = error instanceof WhatsAppSignupError || error instanceof WhatsAppApiError;

    console.error(
      `[whatsapp-oauth] Embedded Signup completion failed at step=${knownStep}`,
      error
    );

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
