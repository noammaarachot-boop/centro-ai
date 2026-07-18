"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";

type Mode = "before" | "after";

const ROWS: { before: string; after: string }[] = [
  {
    before: "מסמכים מפוזרים בין WhatsApp למייל",
    after: "כל המסמכים נאספים במקום אחד",
  },
  {
    before: "לא ברור מה התקבל ומה עדיין חסר",
    after: "ברור מה התקבל ומה עדיין חסר",
  },
  {
    before: "תזכורות נשלחות ידנית",
    after: "תזכורות נשלחות אוטומטית",
  },
  {
    before: "קבצים נשמרים בתיקיות הלא נכונות",
    after: "כל קובץ נשמר במקום הנכון",
  },
  {
    before: "אין תמונת מצב ברורה",
    after: "קיימת תמונת מצב מלאה וברורה",
  },
  {
    before: "עובדים מבזבזים זמן על מעקב",
    after: "Centro מנהל את המעקב",
  },
  {
    before: "לקוחות שוכחים לשלוח מסמכים",
    after: "התהליך מתקדם עד להשלמה",
  },
];

export default function BeforeAfterSection() {
  const [mode, setMode] = useState<Mode>("before");
  const isAfter = mode === "after";

  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          onViewportEnter={() => setMode("after")}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          מבלגן לתהליך מסודר.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          אותו משרד, אותם לקוחות — תהליך איסוף מסמכים שנראה אחרת לגמרי.
        </motion.p>

        {/* Manual toggle: לפני Centro | עם Centro */}
        <div
          role="group"
          aria-label="הצגת המצב לפני או אחרי Centro"
          className="mx-auto mt-8 inline-flex items-center rounded-full border border-border bg-white p-1 shadow-sm"
        >
          <button
            type="button"
            onClick={() => setMode("before")}
            aria-pressed={!isAfter}
            className={`rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
              !isAfter
                ? "bg-danger text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            לפני Centro
          </button>
          <button
            type="button"
            onClick={() => setMode("after")}
            aria-pressed={isAfter}
            className={`rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
              isAfter
                ? "bg-brand-emerald text-white shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            עם Centro
          </button>
        </div>
      </div>

      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-10 max-w-2xl px-4 sm:px-6"
      >
        <div
          className="rounded-[1.75rem] border p-6 shadow-card-lg transition-colors duration-500 sm:p-8"
          style={{
            borderColor: isAfter
              ? "color-mix(in oklab, var(--color-brand-emerald) 30%, var(--color-border))"
              : "color-mix(in oklab, var(--color-danger) 25%, var(--color-border))",
            background: isAfter
              ? "color-mix(in oklab, var(--color-brand-emerald) 4%, white)"
              : "color-mix(in oklab, var(--color-danger) 4%, white)",
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text-secondary">
              {isAfter ? "עם Centro" : "לפני Centro"}
            </span>
            <AnimatePresence mode="wait">
              <motion.span
                key={mode}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className={`rounded-full px-3 py-1 text-xs font-bold ${
                  isAfter
                    ? "bg-brand-emerald/15 text-brand-emerald"
                    : "bg-danger/10 text-danger"
                }`}
              >
                {isAfter ? "הכול מסודר" : "בלאגן"}
              </motion.span>
            </AnimatePresence>
          </div>

          <ul className="mt-5 space-y-2.5">
            {ROWS.map((row, i) => (
              <motion.li
                key={i}
                layout
                className="flex items-center gap-3 rounded-xl bg-white/70 px-3.5 py-3 shadow-sm"
              >
                <span
                  aria-hidden="true"
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors duration-500 ${
                    isAfter
                      ? "bg-brand-emerald/15 text-brand-emerald"
                      : "bg-danger/10 text-danger"
                  }`}
                >
                  {isAfter ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </span>
                <AnimatePresence mode="wait">
                  <motion.span
                    key={mode}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{
                      duration: 0.35,
                      ease: [0.22, 1, 0.36, 1],
                      delay: i * 0.02,
                    }}
                    className="text-sm font-medium text-text-primary sm:text-[0.95rem]"
                  >
                    {isAfter ? row.after : row.before}
                  </motion.span>
                </AnimatePresence>
              </motion.li>
            ))}
          </ul>
        </div>
      </motion.div>
    </section>
  );
}
