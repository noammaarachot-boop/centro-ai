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

interface EmbeddedSignupData {
  phone_number_id?: string;
  waba_id?: string;
}

function loadFacebookSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  return new Promise((resolve) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, xfbml: false, version: FB_SDK_VERSION });
      resolve();
    };
    if (document.querySelector(`script[src="${FB_SDK_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  });
}

// Visually identical to ConnectionRow's generic connect button
// (Step3Connect.tsx) — only the click behavior differs, since a real
// WhatsApp connection needs Meta's Embedded Signup popup instead of a
// plain form submit. The same kind of exception GoogleDriveConnectionRow
// already established as precedent for "a connection that needs more
// than a plain form action."
export function WhatsAppConnectButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
  const signupDataRef = useRef<EmbeddedSignupData>({});

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

  async function connect() {
    setStatus("connecting");
    const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
    const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
    if (!appId || !configId) {
      console.error("[whatsapp] NEXT_PUBLIC_WHATSAPP_APP_ID / NEXT_PUBLIC_WHATSAPP_CONFIG_ID not configured");
      setStatus("error");
      return;
    }

    try {
      await loadFacebookSdk(appId);
      signupDataRef.current = {};

      const response = await new Promise<FacebookLoginResponse>((resolve) => {
        window.FB!.login(resolve, {
          config_id: configId,
          response_type: "code",
          override_default_response_type: true,
        });
      });

      const code = response.authResponse?.code;
      const { waba_id: wabaId, phone_number_id: phoneNumberId } = signupDataRef.current;
      if (!code || !wabaId || !phoneNumberId) {
        // Popup closed or declined without completing signup — not a
        // failure state, just back to idle so the user can retry.
        setStatus("idle");
        return;
      }

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
      console.error("[whatsapp] Embedded Signup failed", error);
      setStatus("error");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={connect}
        disabled={status === "connecting"}
        className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
      >
        {status === "connecting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "חיבור"}
      </button>
      {status === "error" && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          חיבור WhatsApp נכשל. נסו שוב.
        </p>
      )}
    </div>
  );
}
