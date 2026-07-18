"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Accessibility,
  Contrast,
  Palette,
  RotateCcw,
  Underline,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { FONT_STEPS, useAccessibility } from "./AccessibilityProvider";

export default function AccessibilityWidget() {
  const { prefs, increaseFontSize, decreaseFontSize, toggle, reset } =
    useAccessibility();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      panelRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    }
  }, [open]);

  const fontPercent = Math.round(FONT_STEPS[prefs.fontStep] * 100);

  return (
    <div className="fixed bottom-5 left-5 z-[70] sm:bottom-6 sm:left-6">
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            role="region"
            aria-label="הגדרות נגישות"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-full left-0 mb-3 w-[17rem] max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-white p-4 shadow-card-lg"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-text-primary">
                הגדרות נגישות
              </h2>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                aria-label="סגירת הגדרות נגישות"
                className="grid h-8 w-8 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
                <span className="text-sm font-medium text-text-secondary">
                  גודל טקסט
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={decreaseFontSize}
                    disabled={prefs.fontStep === 0}
                    aria-label="הקטנת טקסט"
                    className="grid h-9 w-9 place-items-center rounded-lg border border-border text-text-primary transition-colors hover:bg-surface-muted disabled:opacity-40"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <span
                    className="w-10 text-center text-xs font-semibold text-text-muted"
                    aria-live="polite"
                  >
                    {fontPercent}%
                  </span>
                  <button
                    type="button"
                    onClick={increaseFontSize}
                    disabled={prefs.fontStep === FONT_STEPS.length - 1}
                    aria-label="הגדלת טקסט"
                    className="grid h-9 w-9 place-items-center rounded-lg border border-border text-text-primary transition-colors hover:bg-surface-muted disabled:opacity-40"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <ToggleRow
                label="ניגודיות גבוהה"
                icon={<Contrast className="h-4 w-4" />}
                pressed={prefs.highContrast}
                onClick={() => toggle("highContrast")}
              />
              <ToggleRow
                label="גווני אפור"
                icon={<Palette className="h-4 w-4" />}
                pressed={prefs.grayscale}
                onClick={() => toggle("grayscale")}
              />
              <ToggleRow
                label="קו תחתון לקישורים"
                icon={<Underline className="h-4 w-4" />}
                pressed={prefs.underlineLinks}
                onClick={() => toggle("underlineLinks")}
              />
              <ToggleRow
                label="הפחתת אנימציות"
                icon={<Waves className="h-4 w-4" />}
                pressed={prefs.reducedMotion}
                onClick={() => toggle("reducedMotion")}
              />

              <button
                type="button"
                onClick={reset}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-muted"
              >
                <RotateCcw className="h-4 w-4" />
                איפוס הגדרות נגישות
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "סגירת הגדרות נגישות" : "פתיחת הגדרות נגישות"}
        aria-expanded={open}
        className="grid h-14 w-14 place-items-center rounded-full text-white shadow-card-lg ring-1 ring-white/50 transition-transform hover:scale-105 active:scale-95"
        style={{
          background:
            "linear-gradient(135deg, var(--color-brand-purple), var(--color-brand-blue))",
        }}
      >
        <Accessibility className="h-6 w-6" />
      </button>
    </div>
  );
}

function ToggleRow({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
        pressed
          ? "border-brand-purple/40 bg-brand-purple/10 text-brand-purple-deep"
          : "border-border text-text-secondary hover:bg-surface-muted"
      }`}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span
        aria-hidden="true"
        className={`flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          pressed ? "justify-start bg-brand-purple" : "justify-end bg-border"
        }`}
      >
        <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
      </span>
    </button>
  );
}
