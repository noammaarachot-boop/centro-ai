"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "./Button";
import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
} from "@/lib/whatsapp/hardcodedConfig";

/**
 * Full-page Meta dialog/oauth with a fixed redirect_uri.
 * After App Domains was fixed (no more 191), site origin alone still fails
 * pure 36008 under FB.login — dialog binds a different internal URI.
 * Controlling redirect_uri server-side matches exchange exactly.
 */
export function WhatsAppConnectButton() {
  const [status, setStatus] = useState<"idle" | "connecting">("idle");

  function connect() {
    setStatus("connecting");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = `/api/auth/whatsapp/start?returnTo=${encodeURIComponent(returnTo)}`;
    console.log("[wa-debug] redirecting to full-page WhatsApp OAuth", {
      hardcode: WHATSAPP_HARDCODE_ENABLED,
      appId: WHATSAPP_HARDCODED.appId,
      configId: WHATSAPP_HARDCODED.configId,
      expectedRedirectUri: WHATSAPP_HARDCODED.oauthCallbackUri,
      returnTo,
      url,
    });
    window.location.assign(url);
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
        <p className="mt-1.5 text-xs text-muted-foreground">מעבירים ל-Facebook…</p>
      )}
    </div>
  );
}
