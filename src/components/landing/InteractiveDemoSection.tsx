"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BellRing,
  CheckCircle2,
  FolderCheck,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";
import { WhatsAppGlyph, PDFGlyph, DriveGlyph } from "./icons/IntegrationIcons";
import { CentroMark } from "./icons/CentroMark";

type DemoStep = {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  render: () => React.ReactNode;
};

const DEMO_STEPS: DemoStep[] = [
  {
    label: "הלקוח שולח הודעה",
    Icon: WhatsAppGlyph,
    render: () => (
      <div className="flex items-center gap-2.5 rounded-2xl rounded-tl-sm bg-[#e9fdf1] px-4 py-3 shadow-sm">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-whatsapp text-white shadow-[0_3px_10px_-2px_rgba(37,211,102,0.6)] ring-1 ring-white/70">
          <WhatsAppGlyph className="h-4 w-4" />
        </span>
        <p className="text-sm text-text-primary">הי, מצרפת את הדוחות של הרבעון 👋</p>
      </div>
    ),
  },
  {
    label: "הקובץ מועלה למערכת",
    Icon: PDFGlyph,
    render: () => (
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm">
        <PDFGlyph className="h-8 w-8 text-pdf" />
        <div>
          <p className="text-sm font-semibold text-text-primary">דוח_רבעוני.pdf</p>
          <p className="text-xs text-text-muted">מתקבל אצל Centro…</p>
        </div>
      </div>
    ),
  },
  {
    label: "סריקה וניתוח באמצעות AI",
    Icon: ScanSearch,
    render: () => (
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-blue/10 text-brand-blue">
          <ScanSearch className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-semibold text-text-primary">מזהה סוג ותקופה…</p>
          <p className="text-xs text-text-muted">חשבונית הכנסה · רבעון 2, 2026</p>
        </div>
      </div>
    ),
  },
  {
    label: "מזהה מסמך חסר",
    Icon: BellRing,
    render: () => (
      <div className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 shadow-sm">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-warning/15 text-warning">
          <BellRing className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-semibold text-text-primary">עדיין חסר דף בנק</p>
          <p className="text-xs text-text-secondary">תזכורת אדיבה נשלחת ללקוח אוטומטית</p>
        </div>
      </div>
    ),
  },
  {
    label: "המסמך נשמר בדרייב",
    Icon: DriveGlyph,
    render: () => (
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-drive/10 text-drive ring-1 ring-drive/20">
          <DriveGlyph className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-semibold text-text-primary">נשמר בתיקיית רבעון 2</p>
          <p className="text-xs text-text-muted">גוגל דרייב · לקוח א׳</p>
        </div>
      </div>
    ),
  },
  {
    label: "האיסוף הושלם",
    Icon: FolderCheck,
    render: () => (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-white px-4 py-5 text-center shadow-sm">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-emerald/15 text-brand-emerald">
          <CheckCircle2 className="h-6 w-6" />
        </span>
        <p className="text-sm font-semibold text-text-primary">האיסוף הושלם בהצלחה</p>
        <p className="text-xs text-text-muted">כל זה קרה תוך פחות מחצי דקה, בלי מעורבות ידנית.</p>
      </div>
    ),
  },
];

type DemoState = "prompt" | "playing" | "finished" | "dismissed";

export default function InteractiveDemoSection() {
  const [state, setState] = useState<DemoState>("prompt");
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (state !== "playing") return;
    if (step >= DEMO_STEPS.length - 1) {
      const t = setTimeout(() => setState("finished"), 1800);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), 1500);
    return () => clearTimeout(t);
  }, [state, step]);

  function start() {
    setStep(0);
    setState("playing");
  }

  return (
    <section id="demo" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-2xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          תראו את Centro פועל, בזמן אמת.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-4 max-w-lg text-pretty text-lg leading-relaxed text-text-secondary"
        >
          הדגמה קצרה, ישירות כאן בעמוד — בלי הרשמה ובלי התחברות.
        </motion.p>
      </div>

      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-10 max-w-xl px-4 sm:px-6"
      >
        <div className="rounded-[1.75rem] border border-white/70 bg-white/90 p-5 shadow-card-lg backdrop-blur-xl sm:p-7">
          <AnimatePresence mode="wait">
            {state === "prompt" && (
              <motion.div
                key="prompt"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col items-center gap-4 text-center"
              >
                <span
                  className="grid h-12 w-12 place-items-center rounded-2xl ring-1 ring-white/70 shadow-glow-purple"
                  style={{
                    background:
                      "linear-gradient(155deg, color-mix(in oklab, var(--color-brand-purple) 16%, white), color-mix(in oklab, var(--color-brand-blue) 16%, white))",
                  }}
                >
                  <CentroMark className="h-7 w-7" title="Centro" />
                </span>
                <div>
                  <p className="text-base font-semibold text-text-primary">
                    היי, אני Centro 👋
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                    רוצים לראות איך אני מטפל באיסוף מסמכים בפחות מחצי דקה?
                  </p>
                </div>
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
                  <button
                    type="button"
                    onClick={start}
                    className="rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-6 py-2.5 text-sm font-semibold text-white shadow-card transition-transform hover:scale-[1.02] active:scale-[0.98]"
                  >
                    כן, תראו לי
                  </button>
                  <button
                    type="button"
                    onClick={() => setState("dismissed")}
                    className="rounded-full border border-border px-6 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-muted"
                  >
                    אחר כך
                  </button>
                </div>
              </motion.div>
            )}

            {state === "dismissed" && (
              <motion.div
                key="dismissed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center gap-3 py-4 text-center"
              >
                <p className="text-sm text-text-secondary">
                  בסדר גמור. אפשר לחזור לזה בכל רגע.
                </p>
                <button
                  type="button"
                  onClick={start}
                  className="rounded-full border border-border px-5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted"
                >
                  הפעילו את ההדגמה
                </button>
              </motion.div>
            )}

            {(state === "playing" || state === "finished") && (
              <motion.div
                key="player"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
              >
                <div className="mb-4 flex items-center justify-center gap-1.5" aria-hidden="true">
                  {DEMO_STEPS.map((_, i) => (
                    <span
                      key={i}
                      className="h-1 rounded-full transition-all duration-500"
                      style={{
                        width: i === step ? 20 : 6,
                        backgroundColor:
                          i <= step
                            ? "var(--color-brand-purple)"
                            : "var(--color-border)",
                      }}
                    />
                  ))}
                </div>
                <p className="mb-3 text-center text-xs font-medium text-text-muted">
                  {DEMO_STEPS[step].label}
                </p>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {DEMO_STEPS[step].render()}
                  </motion.div>
                </AnimatePresence>

                {state === "finished" && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-5 flex justify-center"
                  >
                    <button
                      type="button"
                      onClick={start}
                      className="flex items-center gap-2 rounded-full border border-border px-5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted"
                    >
                      <RotateCcw className="h-4 w-4" />
                      הפעילו שוב
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </section>
  );
}
