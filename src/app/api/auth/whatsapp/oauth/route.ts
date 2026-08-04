import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { completeWhatsAppSignup } from "@/lib/whatsapp/completeSignup";
import { WHATSAPP_OAUTH_CALLBACK_URI } from "@/lib/whatsapp/embeddedSignup";
import {
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_STATE_COOKIE,
} from "../start/route";

export const dynamic = "force-dynamic";

const DEFAULT_RETURN_TO = "/settings";

// Meta redirects here after dialog/oauth with ?code=&state= — same
// redirect_uri that was registered at dialog start and used on exchange.
export async function GET(request: NextRequest) {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);
  const cookieStore = await cookies();

  const expectedState = cookieStore.get(WHATSAPP_OAUTH_STATE_COOKIE)?.value;
  const returnTo = cookieStore.get(WHATSAPP_OAUTH_RETURN_TO_COOKIE)?.value || DEFAULT_RETURN_TO;
  const redirectUri =
    cookieStore.get(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE)?.value || WHATSAPP_OAUTH_CALLBACK_URI;

  cookieStore.delete(WHATSAPP_OAUTH_STATE_COOKIE);
  cookieStore.delete(WHATSAPP_OAUTH_RETURN_TO_COOKIE);
  cookieStore.delete(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE);

  const errorSeparator = returnTo.includes("?") ? "&" : "?";
  const fail = (code: string) =>
    NextResponse.redirect(new URL(`${returnTo}${errorSeparator}error=${code}`, request.url));

  const metaError = searchParams.get("error");
  if (metaError) {
    console.error("[whatsapp-oauth] dialog returned error", metaError, searchParams.get("error_description"));
    return fail("whatsapp-denied");
  }

  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    console.error("[whatsapp-oauth] oauth callback invalid state or missing code", {
      hasCode: !!code,
      hasState: !!returnedState,
      hasExpected: !!expectedState,
    });
    return fail("whatsapp-invalid-state");
  }

  try {
    const result = await completeWhatsAppSignup({
      organizationId: session.organizationId,
      userId: session.userId,
      code,
      preferredRedirectUris: [redirectUri],
      onlyPreferred: true,
    });
    console.log("[whatsapp-oauth] dialog/oauth signup ok", {
      wabaId: result.wabaId,
      webhooksSubscribed: result.webhooksSubscribed,
    });
  } catch (error) {
    console.error("[whatsapp-oauth] dialog/oauth signup failed", error);
    return fail("whatsapp-oauth-failed");
  }

  const okSeparator = returnTo.includes("?") ? "&" : "?";
  return NextResponse.redirect(
    new URL(`${returnTo}${okSeparator}whatsapp=connected`, request.url)
  );
}
