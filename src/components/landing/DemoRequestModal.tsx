"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import ContactForm, { SUBMITTED_STORAGE_KEY } from "./ContactForm";
import { CentroMark } from "./icons/CentroMark";
import { WhatsAppOfficialBadge } from "./icons/IntegrationIcons";
import { WHATSAPP_NUMBER } from "./FloatingWhatsAppButton";

const SHOWN_THIS_SESSION_KEY = "centro-demo-modal-shown";
const TRIGGER_DELAY_MS = 15_000;
const RETRY_DELAY_MS = 1_500;
const MODAL_WHATSAPP_MESSAGE =
  "היי! 🤖 ראיתי את חלון ההרשמה באתר ורוצה לדבר עכשיו.";
const MODAL_WHATSAPP_HREF = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(MODAL_WHATSAPP_MESSAGE)}`;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function alreadyHandled() {
  try {
    if (window.sessionStorage.getItem(SHOWN_THIS_SESSION_KEY) === "true") {
      return true;
    }
    if (window.localStorage.getItem(SUBMITTED_STORAGE_KEY) === "true") {
      return true;
    }
  } catch {
    // Storage unavailable — fail open (treat as not yet handled).
  }
  return false;
}

function anotherOverlayOpen() {
  return document.body.style.overflow === "hidden";
}

/**
 * Opens the shared contact form (see ContactForm.tsx) inside a modal,
 * once, 45s after the page loads — unless the visitor already saw it
 * this session, already submitted, or another overlay is open.
 */
export default function DemoRequestModal() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  const close = useCallback(() => {
    setOpen(false);
    previousFocusRef.current?.focus?.({ preventScroll: true });
  }, []);

  // Schedule the 45s trigger once, on initial mount.
  useEffect(() => {
    if (alreadyHandled()) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function attemptOpen() {
      if (cancelled || alreadyHandled()) return;
      if (anotherOverlayOpen()) {
        retryTimer = setTimeout(attemptOpen, RETRY_DELAY_MS);
        return;
      }
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
      try {
        window.sessionStorage.setItem(SHOWN_THIS_SESSION_KEY, "true");
      } catch {
        // non-critical
      }
    }

    const initialTimer = setTimeout(attemptOpen, TRIGGER_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // Lock background scroll + focus trap + Escape handling while open.
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?.focus({ preventScroll: true });
    }, 10);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 bg-[#16132a]/50 backdrop-blur-sm"
            onClick={close}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[1.75rem] border border-white/70 bg-white p-6 shadow-card-lg sm:p-8"
          >
            <button
              type="button"
              onClick={close}
              aria-label="סגירת חלון בקשת הדגמה"
              className="absolute left-4 top-4 grid h-9 w-9 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="text-center">
              <span
                className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl ring-1 ring-white/70 shadow-glow-purple"
                style={{
                  background:
                    "linear-gradient(155deg, color-mix(in oklab, var(--color-brand-purple) 16%, white), color-mix(in oklab, var(--color-brand-blue) 16%, white))",
                }}
              >
                <CentroMark className="h-6 w-6" title="Centro" />
              </span>
              <h2
                id={headingId}
                className="text-balance text-xl font-extrabold leading-tight text-text-primary sm:text-2xl"
              >
                מוכנים לתת ל־Centro להתחיל לעבוד בשבילכם?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                השאירו שם וטלפון ונחזור אליכם להדגמה קצרה.
              </p>
            </div>

            <div className="mt-6">
              <ContactForm idPrefix="demo-modal" source="עמוד הבית — חלון בקשת הדגמה" />
            </div>

            <div className="mt-5 border-t border-border pt-5 text-center">
              <p className="text-sm text-text-secondary">רוצים לדבר איתנו עכשיו?</p>
              <a
                href={MODAL_WHATSAPP_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center justify-center gap-2 rounded-full bg-whatsapp px-5 py-2.5 text-sm font-semibold text-white shadow-card transition-transform hover:scale-[1.02] active:scale-[0.98]"
              >
                <WhatsAppOfficialBadge className="h-5 w-5" />
                אפשר כאן
              </a>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
