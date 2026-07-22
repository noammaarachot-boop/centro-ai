"use client";

import { useEffect, useRef, useState } from "react";
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
      init: (params: { appId: string; xfbml: boolean; version: string }) => void;
      login: (
        callback: (response: FacebookLoginResponse) => void,
        params: { config_id: string; response_type: "code"; override_default_response_type: true }
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const FB_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const FB_SDK_VERSION = "v21.0";
// Meta only ever posts Embedded Signup events from this exact origin —
// checked before parsing so an unrelated postMessage from another script
// on the page can never be mistaken for a signup result.
const SIGNUP_MESSAGE_ORIGIN = "https://www.facebook.com";
// Safety nets so this button can never get stuck spinning forever again —
// see the "why preload" comment on loadFacebookSdk below for the bug this
// class of timeout guards against.
const SDK_LOAD_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 60_000;

interface EmbeddedSignupData {
  phone_number_id?: string;
  waba_id?: string;
}

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

  const promise: Promise<void> = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Facebook SDK load timed out")),
      SDK_LOAD_TIMEOUT_MS
    );

    window.fbAsyncInit = () => {
      clearTimeout(timeout);
      window.FB!.init({ appId, xfbml: false, version: FB_SDK_VERSION });
      resolve();
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${FB_SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Failed to load Facebook SDK"));
      });
      return;
    }
    const script = document.createElement("script");
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      clearTimeout(timeout);
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
  const signupDataRef = useRef<EmbeddedSignupData>({});

  // Preload starts the moment the row renders, not on click — see
  // loadFacebookSdk's comment for why this ordering is load-bearing, not
  // just an optimization.
  useEffect(() => {
    const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
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
        if (!cancelled) setStatus("idle");
      })
      .catch((error) => {
        console.error("[whatsapp] Facebook SDK failed to load", error);
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== SIGNUP_MESSAGE_ORIGIN || typeof event.data !== "string") return;
      try {
        const data = JSON.parse(event.data);
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.event === "FINISH") {
          signupDataRef.current = data.data ?? {};
        }
      } catch {
        // Not JSON — not a signup message, ignore.
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Deliberately synchronous up to the FB.login() call itself — no
  // `await`, no promise chain in between the click and it. See
  // loadFacebookSdk's comment for exactly why that ordering matters.
  function connect() {
    const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
    if (!window.FB || !configId) {
      console.error("[whatsapp] Facebook SDK not ready, or NEXT_PUBLIC_WHATSAPP_CONFIG_ID not configured");
      setStatus("error");
      return;
    }

    setStatus("connecting");
    signupDataRef.current = {};

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error("[whatsapp] Embedded Signup timed out (popup may have been blocked or closed)");
      setStatus("error");
    }, LOGIN_TIMEOUT_MS);

    window.FB.login(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void finishSignup(response);
      },
      { config_id: configId, response_type: "code", override_default_response_type: true }
    );
  }

  async function finishSignup(response: FacebookLoginResponse) {
    const code = response.authResponse?.code;
    const { waba_id: wabaId, phone_number_id: phoneNumberId } = signupDataRef.current;
    if (!code || !wabaId || !phoneNumberId) {
      // Popup closed or declined without completing signup — not a
      // failure state, just back to idle so the user can retry.
      setStatus("idle");
      return;
    }

    try {
      const result = await fetch("/api/auth/whatsapp/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, wabaId, phoneNumberId }),
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
