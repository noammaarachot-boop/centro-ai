"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "./Button";
import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
  getHardcodedConfigId,
  getHardcodedPublicAppId,
} from "@/lib/whatsapp/hardcodedConfig";

function resolvePublicAppId(): string | undefined {
  if (WHATSAPP_HARDCODE_ENABLED) return getHardcodedPublicAppId();
  return process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
}

function resolveConfigId(): string | undefined {
  if (WHATSAPP_HARDCODE_ENABLED) return getHardcodedConfigId();
  return process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
}

// Facebook JS SDK is not packaged with first-party types.
interface FacebookLoginResponse {
  authResponse?: { code?: string };
}
declare global {
  interface Window {
    FB?: {
      init: (params: {
        appId: string;
        cookie: boolean;
        xfbml: boolean;
        autoLogAppEvents: boolean;
        version: string;
      }) => void;
      login: (
        callback: (response: FacebookLoginResponse) => void,
        params: {
          config_id: string;
          response_type: "code";
          override_default_response_type: true;
          extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
        }
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const FB_SDK_VERSION = "v21.0";
const SDK_LOAD_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 60_000;
const DEBUG_PREFIX = "[wa-debug]";

let sdkLoadPromise: Promise<void> | null = null;

// Preload on mount — FB.login() must run synchronously in a real click
// handler (no await between click and login), or the browser may block the popup.
function loadFacebookSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  const promise: Promise<void> = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() => {
        clearInterval(pollForFb);
        reject(new Error("Facebook SDK load timed out"));
      });
    }, SDK_LOAD_TIMEOUT_MS);

    const pollForFb = setInterval(() => {
      if (window.FB) finishInit();
    }, 100);

    const finishInit = () => {
      settle(() => {
        clearTimeout(timeout);
        clearInterval(pollForFb);
        if (!window.FB) {
          reject(new Error("Facebook SDK loaded without FB global"));
          return;
        }
        window.FB.init({
          appId,
          cookie: true,
          xfbml: true,
          autoLogAppEvents: true,
          version: FB_SDK_VERSION,
        });
        resolve();
      });
    };

    window.fbAsyncInit = finishInit;

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${FB_SDK_SRC}"]`);
    if (existing) {
      if (window.FB) {
        finishInit();
        return;
      }
      existing.addEventListener("error", () => {
        settle(() => {
          clearTimeout(timeout);
          clearInterval(pollForFb);
          reject(new Error("Failed to load Facebook SDK"));
        });
      });
      existing.addEventListener("load", () => {
        if (window.FB) finishInit();
      });
      if (window.FB) finishInit();
      return;
    }

    const script = document.createElement("script");
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      settle(() => {
        clearTimeout(timeout);
        clearInterval(pollForFb);
        reject(new Error("Failed to load Facebook SDK"));
      });
    };
    document.body.appendChild(script);
  });

  sdkLoadPromise = promise;
  promise.catch(() => {
    sdkLoadPromise = null;
  });
  return promise;
}

// Official Meta Embedded Signup path: FB.login popup + short-lived code.
// Does NOT use web dialog redirect_uri (that path was stuck on Meta
// "URL Blocked" even with a correct path). Domain must still be listed in
// Valid OAuth Redirect URIs + Allowed Domains for the JavaScript SDK.
export function WhatsAppConnectButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading-sdk" | "idle" | "connecting" | "error">("loading-sdk");

  useEffect(() => {
    const appId = resolvePublicAppId();
    console.log(DEBUG_PREFIX, "WhatsAppConnectButton mounted", {
      hardcode: WHATSAPP_HARDCODE_ENABLED,
      appId,
      configId: resolveConfigId(),
      oauthRedirectUri: WHATSAPP_HARDCODED.oauthRedirectUri,
    });
    let cancelled = false;
    const load = appId
      ? loadFacebookSdk(appId)
      : Promise.reject(new Error("WhatsApp App ID not configured"));
    load
      .then(() => {
        if (!cancelled) setStatus("idle");
      })
      .catch((error) => {
        console.error(DEBUG_PREFIX, "Facebook SDK failed to load", error);
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function connect() {
    const appId = resolvePublicAppId();
    const configId = resolveConfigId();
    console.log(DEBUG_PREFIX, "connect() clicked", {
      hardcode: WHATSAPP_HARDCODE_ENABLED,
      appId,
      configId,
      fbSdkLoaded: !!window.FB,
    });

    if (!window.FB || !configId) {
      setStatus("error");
      return;
    }

    setStatus("connecting");

    // Always use production site root for exchange when hardcoding — not the
    // SPA path, not an env typo.
    const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const pageOrigin = WHATSAPP_HARDCODE_ENABLED
      ? WHATSAPP_HARDCODED.siteOrigin
      : window.location.origin;
    const dialogRedirectUri = WHATSAPP_HARDCODE_ENABLED
      ? WHATSAPP_HARDCODED.siteOriginTrailing
      : `${pageOrigin}/`;
    if (
      !WHATSAPP_HARDCODE_ENABLED &&
      (window.location.pathname !== "/" || window.location.search || window.location.hash)
    ) {
      window.history.replaceState(window.history.state, "", dialogRedirectUri);
    } else if (
      WHATSAPP_HARDCODE_ENABLED &&
      (window.location.origin !== pageOrigin ||
        window.location.pathname !== "/" ||
        window.location.search ||
        window.location.hash)
    ) {
      // Keep FB.login on registered site root when hardcoding diagnosis.
      try {
        window.history.replaceState(window.history.state, "", dialogRedirectUri);
      } catch {
        // ignore
      }
    }
    console.log(DEBUG_PREFIX, "dialogRedirectUri for exchange", {
      dialogRedirectUri,
      hardcode: WHATSAPP_HARDCODE_ENABLED,
    });

    let settled = false;
    const restorePath = () => {
      if (returnPath && returnPath !== "/") {
        try {
          window.history.replaceState(window.history.state, "", returnPath);
        } catch {
          // ignore
        }
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      restorePath();
      console.error(DEBUG_PREFIX, "FB.login() timed out");
      setStatus("error");
    }, LOGIN_TIMEOUT_MS);

    const loginParams = {
      config_id: configId,
      response_type: "code" as const,
      override_default_response_type: true as const,
      extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
    };
    console.log(DEBUG_PREFIX, "calling window.FB.login()", loginParams);

    window.FB.login((response) => {
      console.log(DEBUG_PREFIX, "FB.login() callback", JSON.parse(JSON.stringify(response ?? null)));
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      restorePath();
      void finishSignup(response, dialogRedirectUri, pageOrigin);
    }, loginParams);
  }

  async function finishSignup(
    response: FacebookLoginResponse,
    dialogRedirectUri: string,
    pageOrigin: string
  ) {
    const code = response.authResponse?.code;
    console.log(DEBUG_PREFIX, "finishSignup()", { hasCode: !!code, dialogRedirectUri });
    if (!code) {
      setStatus("idle");
      return;
    }

    try {
      const redirectUris = WHATSAPP_HARDCODE_ENABLED
        ? [
            WHATSAPP_HARDCODED.siteOriginTrailing,
            WHATSAPP_HARDCODED.siteOrigin,
            WHATSAPP_HARDCODED.oauthRedirectUri,
          ]
        : [dialogRedirectUri, pageOrigin, `${pageOrigin}/`];

      const result = await fetch("/api/auth/whatsapp/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          redirectUri: dialogRedirectUri,
          redirectUris,
        }),
      });
      type CallbackPayload = {
        error?: string;
        step?: string;
        ok?: boolean;
        webhooksSubscribed?: boolean;
        meta?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          tried_redirect_uri?: string | null;
          attempts?: Array<{ redirectUri: string; status: number; code?: number; error_subcode?: number }>;
        };
      };
      let payload: CallbackPayload | null = null;
      try {
        payload = (await result.json()) as CallbackPayload;
      } catch {
        payload = null;
      }

      if (!result.ok) {
        console.error(
          DEBUG_PREFIX,
          "callback API failed",
          "status=",
          result.status,
          "error=",
          payload?.error ?? "unknown",
          "step=",
          payload?.step ?? "unknown",
          "meta.message=",
          payload?.meta?.message ?? "(none)",
          "meta.code=",
          payload?.meta?.code ?? "(none)",
          "meta.error_subcode=",
          payload?.meta?.error_subcode ?? "(none)",
          "meta.tried_redirect_uri=",
          payload?.meta?.tried_redirect_uri === undefined
            ? "(none)"
            : String(payload.meta.tried_redirect_uri),
          "dialogRedirectUri=",
          dialogRedirectUri,
          "meta.attempts=",
          JSON.stringify(payload?.meta?.attempts ?? [])
        );
        setStatus("error");
        return;
      }

      console.log(DEBUG_PREFIX, "callback API ok", {
        webhooksSubscribed: payload?.webhooksSubscribed,
      });
      setStatus("idle");
      router.refresh();
    } catch (error) {
      console.error(DEBUG_PREFIX, "Embedded Signup completion failed", error);
      setStatus("error");
    }
  }

  const isBusy = status === "connecting" || status === "loading-sdk";

  return (
    <div>
      <button
        type="button"
        onClick={connect}
        disabled={isBusy}
        className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
      >
        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "חיבור"}
      </button>
      {status === "error" && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          חיבור WhatsApp נכשל. נסו שוב.
        </p>
      )}
    </div>
  );
}
