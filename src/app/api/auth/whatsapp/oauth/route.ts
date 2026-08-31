import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { completeWhatsAppSignup } from "@/lib/whatsapp/completeSignup";
import { WHATSAPP_OAUTH_CALLBACK_URI, WhatsAppSignupError } from "@/lib/whatsapp/embeddedSignup";
import {
  WHATSAPP_OAUTH_REDIRECT_URI_COOKIE,
  WHATSAPP_OAUTH_RETURN_TO_COOKIE,
  WHATSAPP_OAUTH_STATE_COOKIE,
  buildPopupResultHtml,
  buildReturnRedirect,
  decodeWhatsAppOAuthState,
} from "@/lib/whatsapp/oauthState";

export const dynamic = "force-dynamic";

const DEFAULT_RETURN_TO = "/settings";
const POPUP_COOKIE = "whatsapp_oauth_popup";

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);

  const cookieCsrf = request.cookies.get(WHATSAPP_OAUTH_STATE_COOKIE)?.value;
  const cookieReturnTo = request.cookies.get(WHATSAPP_OAUTH_RETURN_TO_COOKIE)?.value;
  const cookieRedirectUri = request.cookies.get(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE)?.value;
  const popupCookie = request.cookies.get(POPUP_COOKIE)?.value === "1";

  const returnedState = searchParams.get("state") ?? "";
  const signed = decodeWhatsAppOAuthState(returnedState);

  const returnTo = signed?.returnTo || cookieReturnTo || DEFAULT_RETURN_TO;
  const redirectUri =
    signed?.redirectUri || cookieRedirectUri || WHATSAPP_OAUTH_CALLBACK_URI;
  const popup = signed?.popup === true || popupCookie;

  const clearAuthCookies = (res: NextResponse) => {
    res.cookies.delete(WHATSAPP_OAUTH_STATE_COOKIE);
    res.cookies.delete(WHATSAPP_OAUTH_RETURN_TO_COOKIE);
    res.cookies.delete(WHATSAPP_OAUTH_REDIRECT_URI_COOKIE);
    res.cookies.delete(POPUP_COOKIE);
    return res;
  };

  const finish = (opts: { ok: boolean; error?: string; reason?: string }) => {
    if (popup) {
      const html = buildPopupResultHtml({
        ok: opts.ok,
        error: opts.error,
        returnTo,
      });
      return clearAuthCookies(
        new NextResponse(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      );
    }
    const path = opts.ok
      ? buildReturnRedirect(returnTo, { whatsapp: "connected" })
      : buildReturnRedirect(returnTo, {
          error: opts.error ?? "whatsapp-oauth-failed",
          // Our own Hebrew explanation when there is one, so the screen
          // can say what to do rather than only that it failed.
          ...(opts.reason ? { whatsappError: opts.reason } : {}),
        });
    return clearAuthCookies(NextResponse.redirect(new URL(path, request.url)));
  };

  // Owner-initiated repair: the organization rides in the SIGNED state,
  // and is honoured only for an authenticated platform owner. Both are
  // required — the signature stops the id being swapped in the URL, and
  // the owner session stops a signed state being replayed by anyone else.
  // Without this pairing an employee of office A could finish a flow that
  // writes office B's credentials.
  // Owner-initiated repair, started from the owner console.
  //
  // The organization rides inside the HMAC-signed state, so it cannot be
  // edited in the URL, and the csrf cookie set when the flow began must
  // match — which ties this callback to the very browser that started it,
  // where an authenticated platform owner was required. The owner session
  // itself is not re-checked here because its cookie is deliberately scoped
  // to /owner and is never sent to this route; the signature plus the csrf
  // binding is what carries the authorisation across.
  let ownerRepairOrganizationId: string | null = null;
  if (signed?.organizationId) {
    if (!cookieCsrf || cookieCsrf !== signed.csrf) {
      console.error("[whatsapp-oauth] owner-repair state without a matching csrf cookie — refused");
      return finish({ ok: false, error: "whatsapp-invalid-state" });
    }
    ownerRepairOrganizationId = signed.organizationId;
  } else if (!session) {
    console.error("[whatsapp-oauth] oauth callback without session");
    return finish({ ok: false, error: "whatsapp-session-lost" });
  }

  const metaError = searchParams.get("error");
  if (metaError) {
    console.error(
      "[whatsapp-oauth] dialog returned error",
      metaError,
      searchParams.get("error_description")
    );
    return finish({ ok: false, error: "whatsapp-denied" });
  }

  const code = searchParams.get("code");
  const signedOk = !!signed;
  const cookieOk = !cookieCsrf || !signed || cookieCsrf === signed.csrf;
  if (!code || !signedOk || !cookieOk) {
    console.error("[whatsapp-oauth] oauth callback invalid state or missing code", {
      hasCode: !!code,
      signedOk,
      cookieOk,
      hasCookieCsrf: !!cookieCsrf,
      popup,
    });
    if (!code) {
      // Duplicate Facebook hit without code — quiet close for popup.
      return finish({ ok: true });
    }
    return finish({ ok: false, error: "whatsapp-invalid-state" });
  }

  try {
    const result = await completeWhatsAppSignup({
      organizationId: ownerRepairOrganizationId ?? session!.organizationId,
      userId: session?.userId ?? "owner",
      code,
      preferredRedirectUris: [redirectUri],
      onlyPreferred: true,
    });
    console.log("[whatsapp-oauth] dialog/oauth signup ok", {
      wabaId: result.wabaId,
      webhooksSubscribed: result.webhooksSubscribed,
      displayPhoneNumber: result.displayPhoneNumber,
      popup,
    });
    return finish({ ok: true });
  } catch (error) {
    console.error("[whatsapp-oauth] dialog/oauth signup failed", error);
    const msg = error instanceof Error ? error.message : String(error);
    if (/already been used|code has expired|verification code has expired/i.test(msg)) {
      return finish({ ok: true });
    }
    // Carry the real reason back instead of one opaque code.
    //
    // Every failure used to collapse to "whatsapp-oauth-failed", so an
    // operator who picked the wrong WhatsApp account in Meta's dialog — the
    // most likely mistake, and a completely recoverable one — was told only
    // that the connection failed, with no way to know what to do differently.
    // The message is generated by us and contains ids, never tokens.
    if (error instanceof WhatsAppSignupError && error.publicMeta?.message) {
      return finish({
        ok: false,
        error: "whatsapp-oauth-failed",
        reason: error.message,
      });
    }
    return finish({ ok: false, error: "whatsapp-oauth-failed" });
  }
}
