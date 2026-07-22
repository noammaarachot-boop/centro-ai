"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "./Button";

// No first-party npm types for the Facebook JS SDK — same reasoning as
// GoogleDriveFolderPicker.tsx's hand-written Picker declarations: only the
// handful of calls this file actually makes.
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
// Safety nets so this button can never get stuck spinning forever again —
// see the "why preload" comment on loadFacebookSdk below for the bug this
// class of timeout guards against.
const SDK_LOAD_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 60_000;

// Temporary, verbose diagnostic logging for the live Embedded Signup
// investigation — every SDK lifecycle event and the exact params/response
// passed to and from FB.login(), all prefixed for easy console filtering.
// Safe to trim back down once live verification is fully closed out.
const DEBUG_PREFIX = "[wa-debug]";

let sdkLoadPromise: Promise<void> | null = null;

// Deliberately started as early as possible (component mount, see the
// useEffect below) and kept entirely separate from the click handler.
// FB.login() must be called synchronously inside a real click event's own
// call stack, or the browser no longer treats its popup as user-initiated
// and silently blocks it — no error, no callback, nothing. The original
// bug here was `await loadFacebookSdk(appId)` sitting between the click
// and `FB.login()`: even with the SDK cached, that `await` yields at
// least one microtask, which was enough for some browsers to drop the
// click's user-activation flag, so the popup never opened and the
// promise wrapping FB.login() waited forever for a callback that was
// never going to fire.
function loadFacebookSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  console.log(DEBUG_PREFIX, "loadFacebookSdk() starting", { appId, sdkVersion: FB_SDK_VERSION });

  const promise: Promise<void> = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(DEBUG_PREFIX, "SDK load timed out after", SDK_LOAD_TIMEOUT_MS, "ms");
      reject(new Error("Facebook SDK load timed out"));
    }, SDK_LOAD_TIMEOUT_MS);

    window.fbAsyncInit = () => {
      clearTimeout(timeout);
      // Matches Meta's own Embedded Signup sample init call exactly
      // (cookie/xfbml/autoLogAppEvents included even though this button
      // uses none of the page-parsing or cookie-session features they
      // enable, for full parity with the documented shape).
      const initParams = { appId, cookie: true, xfbml: true, autoLogAppEvents: true, version: FB_SDK_VERSION };
      console.log(DEBUG_PREFIX, "fbAsyncInit fired, calling FB.init()", initParams);
      window.FB!.init(initParams);
      console.log(DEBUG_PREFIX, "FB.init() complete, window.FB =", window.FB);
      resolve();
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${FB_SDK_SRC}"]`);
    if (existing) {
      console.log(DEBUG_PREFIX, "SDK script tag already present, waiting for fbAsyncInit");
      existing.addEventListener("error", () => {
        clearTimeout(timeout);
        console.error(DEBUG_PREFIX, "existing SDK script tag errored");
        reject(new Error("Failed to load Facebook SDK"));
      });
      return;
    }
    console.log(DEBUG_PREFIX, "appending SDK script tag", FB_SDK_SRC);
    const script = document.createElement("script");
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      clearTimeout(timeout);
      console.error(DEBUG_PREFIX, "SDK script tag failed to load");
      reject(new Error("Failed to load Facebook SDK"));
    };
    document.body.appendChild(script);
  });

  sdkLoadPromise = promise;
  // A failed load must not stay cached — the next mount/click gets a
  // fresh attempt instead of being permanently stuck on one failure
  // (e.g. a transient network blip). Fire-and-forget: the caller's own
  // `promise` reference still carries the rejection.
  promise.catch(() => {
    sdkLoadPromise = null;
  });

  return promise;
}

// Visually identical to ConnectionRow's generic connect button
// (Step3Connect.tsx) — only the click behavior differs, since a real
// WhatsApp connection needs Meta's Embedded Signup popup instead of a
// plain form submit. The same kind of exception GoogleDriveConnectionRow
// already established as precedent for "a connection that needs more
// than a plain form action."
export function WhatsAppConnectButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading-sdk" | "idle" | "connecting" | "error">("loading-sdk");

  // Preload starts the moment the row renders, not on click — see
  // loadFacebookSdk's comment for why this ordering is load-bearing, not
  // just an optimization.
  useEffect(() => {
    const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
    const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
    console.log(DEBUG_PREFIX, "WhatsAppConnectButton mounted", { appId, configId, location: window.location.href });

    let cancelled = false;
    // Routed through the same load/catch promise chain even when appId is
    // missing (rather than an early synchronous setState) so every status
    // transition here happens inside a promise callback, not directly in
    // the effect body.
    const load = appId
      ? loadFacebookSdk(appId)
      : Promise.reject(new Error("NEXT_PUBLIC_WHATSAPP_APP_ID not configured"));
    load
      .then(() => {
        console.log(DEBUG_PREFIX, "SDK load promise resolved — status -> idle");
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

  // A WA_EMBEDDED_SIGNUP postMessage listener used to live here, meant to
  // capture waba_id/phone_number_id directly from Meta. Removed after
  // live testing (including a correctly-configured `extras` param on
  // FB.login()) confirmed Meta never sends it for this app/configuration
  // — the [wa-debug] logging showed FB.login()'s own callback firing with
  // a valid code, but zero postMessage events ever arriving. Both ids are
  // now derived entirely server-side from the exchanged code instead (see
  // POST /api/auth/whatsapp/callback).

  // Deliberately synchronous up to the FB.login() call itself — no
  // `await`, no promise chain in between the click and it. See
  // loadFacebookSdk's comment for exactly why that ordering matters.
  function connect() {
    const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
    const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
    console.log(DEBUG_PREFIX, "connect() clicked", {
      appId,
      configId,
      fbSdkLoaded: !!window.FB,
    });

    if (!window.FB || !configId) {
      console.error(DEBUG_PREFIX, "aborting: Facebook SDK not ready, or NEXT_PUBLIC_WHATSAPP_CONFIG_ID not configured");
      setStatus("error");
      return;
    }

    setStatus("connecting");

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(DEBUG_PREFIX, "FB.login() timed out after", LOGIN_TIMEOUT_MS, "ms — popup may have been blocked or closed without ever calling back");
      setStatus("error");
    }, LOGIN_TIMEOUT_MS);

    // `extras` is what actually turns this on as Embedded Signup rather
    // than a plain Business Login — without it, Meta only ever returns
    // the authorization code via this callback and never sends the
    // WA_EMBEDDED_SIGNUP postMessage events carrying waba_id/
    // phone_number_id, which is exactly the bug this fixes.
    const loginParams = {
      config_id: configId,
      response_type: "code" as const,
      override_default_response_type: true as const,
      extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
    };
    console.log(DEBUG_PREFIX, "calling window.FB.login() with params", loginParams);

    window.FB.login((response) => {
      console.log(DEBUG_PREFIX, "FB.login() callback fired", JSON.parse(JSON.stringify(response ?? null)));
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void finishSignup(response);
    }, loginParams);
  }

  async function finishSignup(response: FacebookLoginResponse) {
    const code = response.authResponse?.code;
    console.log(DEBUG_PREFIX, "finishSignup()", { hasCode: !!code });
    if (!code) {
      // Popup closed or declined without completing signup — not a
      // failure state, just back to idle so the user can retry.
      setStatus("idle");
      return;
    }

    try {
      const result = await fetch("/api/auth/whatsapp/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!result.ok) {
        setStatus("error");
        return;
      }
      setStatus("idle");
      router.refresh();
    } catch (error) {
      console.error("[whatsapp] Embedded Signup completion failed", error);
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
