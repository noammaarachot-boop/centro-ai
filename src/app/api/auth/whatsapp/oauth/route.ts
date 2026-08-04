import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { completeWhatsAppSignup } from "@/lib/whatsapp/completeSignup";
import { WHATSAPP_OAUTH_CALLBACK_URI } from "@/lib/whatsapp/embeddedSignup";
import {
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_STATE_COOKIE,
  buildReturnRedirect,
  decodeWhatsAppOAuthState,
} from "@/lib/whatsapp/oauthState";

export const dynamic = "force-dynamic";

const DEFAULT_RETURN_TO = "/settings";

// Meta redirects here after dialog/oauth with ?code=&state=.
// State is a signed payload (returnTo + redirectUri + csrf) so the
// exchange works even if browser cookies are dropped on the way back
// from Facebook. Cookie csrf is an extra defense when present.
export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);

  const cookieCsrf = request.cookies.get(WHATSAPP_OAUTH_STATE_COOKIE)?.value;
  const cookieReturnTo = request.cookies.get(WHATSAPP_OAUTH_RETURN_TO_COOKIE)?.value;
  const cookieRedirectUri = request.cookies.get(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE)?.value;

  const returnedState = searchParams.get("state") ?? "";
  const signed = decodeWhatsAppOAuthState(returnedState);

  const returnTo = signed?.returnTo || cookieReturnTo || DEFAULT_RETURN_TO;
  const redirectUri =
    signed?.redirectUri || cookieRedirectUri || WHATSAPP_OAUTH_CALLBACK_URI;

  const clearAuthCookies = (res: NextResponse) => {
    res.cookies.delete(WHATSAPP_OAUTH_STATE_COOKIE);
    res.cookies.delete(WHATSAPP_OAUTH_RETURN_TO_COOKIE);
    res.cookies.delete(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE);
    return res;
  };

  const redirectTo = (path: string) =>
    clearAuthCookies(NextResponse.redirect(new URL(path, request.url)));

  if (!session) {
    console.error("[whatsapp-oauth] oauth callback without session");
    // Code expires in ~30s — cannot recover after login. Ask user to retry.
    return redirectTo(buildReturnRedirect("/login", { error: "whatsapp-session-lost" }));
  }

  const metaError = searchParams.get("error");
  if (metaError) {
    console.error(
      "[whatsapp-oauth] dialog returned error",
      metaError,
      searchParams.get("error_description")
    );
    return redirectTo(buildReturnRedirect(returnTo, { error: "whatsapp-denied" }));
  }

  const code = searchParams.get("code");

  // Prefer signed state (survives missing cookies). Cookie csrf is optional
  // extra match when the browser kept cookies.
  const signedOk = !!signed;
  const cookieOk = !cookieCsrf || !signed || cookieCsrf === signed.csrf;
  if (!code || !signedOk || !cookieOk) {
    console.error("[whatsapp-oauth] oauth callback invalid state or missing code", {
      hasCode: !!code,
      signedOk,
      cookieOk,
      hasCookieCsrf: !!cookieCsrf,
    });
    // Facebook often hits the callback twice; if connection succeeded on the
    // first hit, a bare second hit without cookies should not flash failure.
    // If we have no code (repeat #_=_ navigation), send a neutral return.
    if (!code) {
      return redirectTo(buildReturnRedirect(returnTo, {}));
    }
    return redirectTo(buildReturnRedirect(returnTo, { error: "whatsapp-invalid-state" }));
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
      displayPhoneNumber: result.displayPhoneNumber,
    });
  } catch (error) {
    console.error("[whatsapp-oauth] dialog/oauth signup failed", error);
    // Code already used / consumed often means first callback already stored.
    const msg = error instanceof Error ? error.message : String(error);
    if (/already been used|code has expired|verification code has expired/i.test(msg)) {
      return redirectTo(buildReturnRedirect(returnTo, { whatsapp: "connected" }));
    }
    return redirectTo(buildReturnRedirect(returnTo, { error: "whatsapp-oauth-failed" }));
  }

  return redirectTo(buildReturnRedirect(returnTo, { whatsapp: "connected" }));
}
