"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "./Button";

// Full-page Facebook Login for Business dialog (not FB.login popup).
// Dialog uses redirect_uri=https://www.centro-ai.co.il/api/auth/whatsapp/oauth
// so code exchange can echo that URI and avoid Meta 36008/191 mismatches
// from the JS SDK's opaque internal redirect.
export function WhatsAppConnectButton() {
  const [status, setStatus] = useState<"idle" | "connecting">("idle");

  function connect() {
    setStatus("connecting");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = `/api/auth/whatsapp/start?returnTo=${encodeURIComponent(returnTo)}`;
    console.log("[wa-debug] redirecting to WhatsApp OAuth start", { returnTo, url });
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
