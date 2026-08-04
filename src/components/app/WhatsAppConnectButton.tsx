"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "./Button";
import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
} from "@/lib/whatsapp/hardcodedConfig";

const DEBUG_PREFIX = "[wa-debug]";
const POPUP_NAME = "centro_whatsapp_oauth";
const POPUP_FEATURES = "popup=yes,width=600,height=720,menubar=no,toolbar=no,status=no";

/**
 * Opens Meta OAuth in a **popup** (like the old FB.login UX), but uses our
 * controlled dialog/oauth + redirect_uri so code exchange keeps working.
 * Full-page navigation is only used if the browser blocks the popup.
 */
export function WhatsAppConnectButton() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        ok?: boolean;
        error?: string | null;
      } | null;
      if (!data || data.type !== "centro-whatsapp-oauth") return;

      console.log(DEBUG_PREFIX, "popup postMessage", data);
      if (data.ok) {
        setStatus("idle");
        router.refresh();
      } else {
        setStatus("error");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  function connect() {
    setStatus("connecting");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = `/api/auth/whatsapp/start?popup=1&returnTo=${encodeURIComponent(returnTo)}`;
    console.log(DEBUG_PREFIX, "opening WhatsApp OAuth popup", {
      hardcode: WHATSAPP_HARDCODE_ENABLED,
      appId: WHATSAPP_HARDCODED.appId,
      configId: WHATSAPP_HARDCODED.configId,
      expectedRedirectUri: WHATSAPP_HARDCODED.oauthCallbackUri,
      returnTo,
      url,
    });

    // Must open synchronously in the click handler (user gesture) or browsers block it.
    const popup = window.open(url, POPUP_NAME, POPUP_FEATURES);
    if (!popup) {
      console.warn(DEBUG_PREFIX, "popup blocked — falling back to full-page OAuth");
      window.location.assign(url);
      return;
    }

    // Detect closed without completing so the button does not spin forever.
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(poll);
        setStatus((current) => (current === "connecting" ? "idle" : current));
        return;
      }
      if (Date.now() - started > 5 * 60_000) {
        window.clearInterval(poll);
        try {
          popup.close();
        } catch {
          // ignore
        }
        setStatus("error");
      }
    }, 500);
  }

  const isBusy = status === "connecting";

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
      {isBusy && (
        <p className="mt-1.5 text-xs text-muted-foreground">נפתח חלון Facebook…</p>
      )}
      {status === "error" && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          חיבור WhatsApp נכשל. נסו שוב.
        </p>
      )}
    </div>
  );
}
