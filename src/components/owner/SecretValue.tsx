"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

// Shows a stored secret masked, with an explicit reveal.
//
// Two deliberate properties:
//   • Masked on every mount. Component state is not persisted anywhere, so
//     a refresh, a navigation, or a re-render always returns to hidden —
//     the value can never be left exposed on screen by accident.
//   • The real value is rendered by the server into the DOM either way, so
//     this is a shoulder-surfing guard for a value the owner is already
//     authorised to see — not an access control. Access control is the
//     owner session gate on the page itself.
export function SecretValue({ value, label }: { value: string; label?: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <code
        dir="ltr"
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text-primary"
      >
        {revealed ? value : "•".repeat(Math.min(value.length, 32))}
      </code>
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        aria-pressed={revealed}
        aria-label={revealed ? `הסתרת ${label ?? "הערך"}` : `הצגת ${label ?? "הערך"}`}
        className="shrink-0 rounded-lg border border-border p-2 text-text-muted transition-colors hover:border-brand-purple/40 hover:text-brand-purple"
      >
        {revealed ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
