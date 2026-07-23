"use client";

import { useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useScroll,
  type PanInfo,
} from "framer-motion";
import {
  BellRing,
  CheckCheck,
  FolderCheck,
  ScanSearch,
  Send,
} from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";
import { WhatsAppGlyph, PDFGlyph, DriveGlyph } from "./icons/IntegrationIcons";

type Step = {
  title: string;
  description: string;
  chip: string;
  Icon: React.ComponentType<{ className?: string }>;
  accent: string;
};

const STEPS: Step[] = [
  {
    title: "Centro פונה ללקוח",
    description:
      "הודעה אישית נשלחת בערוץ שהלקוח כבר משתמש בו — וואטסאפ או מייל — עם רשימה ברורה של מה נדרש.",
    chip: "נשלחה בקשה למסמכי יוני",
    Icon: Send,
    accent: "from-brand-purple to-brand-blue",
  },
  {
    title: "המסמכים מתקבלים ומנותחים",
    description:
      "כל קובץ שמתקבל נסרק אוטומטית: סוג המסמך, התקופה הרלוונטית והאם הוא כפול.",
    chip: "3 מסמכים נותחו בהצלחה",
    Icon: ScanSearch,
    accent: "from-brand-blue to-brand-cyan",
  },
  {
    title: "מה שחסר נרדף אוטומטית",
    description:
      "Centro מזהה פערים ושולח תזכורת מנומסת בזמן הנכון — בלי שתצטרכו לזכור בעצמכם.",
    chip: "תזכורת נשלחה עבור דף בנק",
    Icon: BellRing,
    accent: "from-brand-coral to-brand-pink",
  },
  {
    title: "הכול נשמר ומסתדר",
    description:
      "קבצים עוברים לתיקייה הנכונה בגוגל דרייב, והמשרד מקבל תמונת מצב עדכנית בזמן אמת.",
    chip: "התיק נסגר ונשמר בדרייב",
    Icon: FolderCheck,
    accent: "from-brand-emerald to-brand-cyan",
  },
];

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="relative py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.span
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-sm font-semibold uppercase tracking-wide text-brand-purple"
        >
          איך זה עובד
        </motion.span>
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mt-3 text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          ארבעה שלבים, בלי שום מעורבות ידנית.
        </motion.h2>
      </div>

      <div className="hidden sm:block">
        <DesktopSteps />
      </div>
      <div className="sm:hidden">
        <MobileSteps />
      </div>
    </section>
  );
}

// Desktop/tablet — unchanged scroll-jacking behavior: a tall wrapper pins
// a sticky panel while scrollYProgress drives which step is active. Left
// exactly as it was; only extracted into its own component so the mobile
// variant below can live alongside it without touching this logic.
function DesktopSteps() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: wrapperRef,
    offset: ["start start", "end end"],
  });

  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const idx = Math.min(STEPS.length - 1, Math.floor(v * STEPS.length));
    setActive(Math.max(0, idx));
  });

  return (
    <div ref={wrapperRef} className="relative mt-14 h-[280vh] sm:h-[320vh]">
      <div className="sticky top-20 flex h-[calc(100vh-6rem)] max-h-[42rem] items-center overflow-hidden sm:top-24">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16">
          {/* Step index rail */}
          <div className="order-2 flex flex-col gap-2 lg:order-1">
            {STEPS.map((step, i) => (
              <button
                key={step.title}
                type="button"
                onClick={() => {
                  const el = wrapperRef.current;
                  if (!el) return;
                  const top =
                    el.offsetTop + (el.offsetHeight * i) / STEPS.length + 4;
                  window.scrollTo({ top, behavior: "smooth" });
                }}
                className="group flex items-center gap-4 rounded-2xl p-3 text-right transition-colors"
                aria-current={active === i}
              >
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold transition-colors ${
                    active === i
                      ? "bg-gradient-to-br text-white " + step.accent
                      : "bg-surface-muted text-text-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <span>
                  <span
                    className={`block text-base font-semibold transition-colors ${
                      active === i ? "text-text-primary" : "text-text-muted"
                    }`}
                  >
                    {step.title}
                  </span>
                  <AnimatePresence>
                    {active === i && (
                      <motion.span
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                        className="block max-w-sm text-sm leading-relaxed text-text-secondary"
                      >
                        {step.description}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </button>
            ))}
          </div>

          {/* Visual */}
          <div className="order-1 flex justify-center lg:order-2">
            <div className="relative h-72 w-72 rounded-[2rem] border border-white/70 bg-white shadow-card-lg sm:h-80 sm:w-80">
              <div
                className="absolute inset-0 rounded-[2rem] opacity-[0.07]"
                style={{ background: "var(--gradient-hero)" }}
                aria-hidden="true"
              />
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="relative flex h-full w-full flex-col items-center justify-center gap-5 p-8"
                >
                  <StepVisual index={active} />
                  <span className="rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm">
                    {STEPS[active].chip}
                  </span>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Mobile — the scroll-jacked sticky panel above is uncomfortable on touch
// (it needs many small vertical scroll gestures to advance, and fights
// the browser's own momentum scrolling). This is a normal-flow, fixed-
// height swipe carousel instead: no tall wrapper, no sticky, no
// scroll-linked state — the page scrolls past it exactly like any other
// section once the visitor is done swiping through it.
const SWIPE_THRESHOLD_PX = 45;

function MobileSteps() {
  const [active, setActive] = useState(0);

  function goTo(index: number) {
    setActive(Math.max(0, Math.min(STEPS.length - 1, index)));
  }

  function handleDragEnd(
    _event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo
  ) {
    if (info.offset.x < -SWIPE_THRESHOLD_PX) {
      goTo(active + 1);
    } else if (info.offset.x > SWIPE_THRESHOLD_PX) {
      goTo(active - 1);
    }
  }

  return (
    <div className="mt-10">
      {/* Step numbers double as tabs — tapping one jumps straight there. */}
      <div className="flex items-center justify-center gap-2 px-4">
        {STEPS.map((step, i) => (
          <button
            key={step.title}
            type="button"
            onClick={() => goTo(i)}
            aria-label={`שלב ${i + 1}: ${step.title}`}
            aria-current={active === i}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold transition-colors ${
              active === i
                ? "bg-gradient-to-br text-white " + step.accent
                : "bg-surface-muted text-text-muted"
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* dir="ltr" on the track is the actual fix, not decoration: under
          the page's real dir="rtl", a flex child is anchored to the RIGHT
          edge by default, so translating the track further left (to
          reveal a later step) dragged the whole thing off-screen to the
          left instead of sliding the next card into view — the identical
          bug already documented and fixed in TestimonialsSection's
          marquee. Forcing ltr here anchors the track's left edge at the
          viewport's left edge, which is what the translateX math assumes;
          dir="rtl" is re-applied per-card below so the Hebrew content
          inside still reads correctly. */}
      <div className="mt-6 overflow-hidden px-4">
        <motion.div
          dir="ltr"
          className="flex"
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.2}
          onDragEnd={handleDragEnd}
          animate={{ x: `-${active * 100}%` }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {STEPS.map((step, i) => (
            <div key={step.title} dir="rtl" className="w-full shrink-0 px-1">
              <div className="relative mx-auto flex h-64 w-full max-w-[15rem] flex-col items-center justify-center gap-5 rounded-[2rem] border border-white/70 bg-white p-6 shadow-card-lg">
                <div
                  className="absolute inset-0 rounded-[2rem] opacity-[0.07]"
                  style={{ background: "var(--gradient-hero)" }}
                  aria-hidden="true"
                />
                <StepVisual index={i} />
                <span className="relative rounded-full border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm">
                  {step.chip}
                </span>
              </div>
              <div className="mt-5 px-2 text-center">
                <p className="text-base font-semibold text-text-primary">
                  {step.title}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Pagination dots */}
      <div className="mt-6 flex items-center justify-center gap-1.5" aria-hidden="true">
        {STEPS.map((step, i) => (
          <span
            key={step.title}
            className="h-1.5 rounded-full transition-all duration-300"
            style={{
              width: i === active ? 20 : 6,
              backgroundColor:
                i === active ? "var(--color-brand-purple)" : "var(--color-border)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function StepVisual({ index }: { index: number }) {
  const step = STEPS[index];
  const { Icon, accent } = step;

  if (index === 0) {
    return (
      <div className="relative">
        <span
          className={`grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br text-white shadow-glow-purple ${accent}`}
        >
          <Icon className="h-9 w-9" />
        </span>
        <span className="absolute -bottom-2 -left-3 grid h-9 w-9 place-items-center rounded-full bg-white text-whatsapp shadow-card">
          <WhatsAppGlyph className="h-5 w-5" />
        </span>
      </div>
    );
  }
  if (index === 1) {
    return (
      <div className="relative flex h-20 w-16 items-center justify-center rounded-xl border border-border bg-white shadow-card">
        <PDFGlyph className="h-8 w-8 text-pdf" />
        <motion.span
          animate={{ top: ["10%", "90%", "10%"] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-x-0 h-4"
          style={{
            background:
              "linear-gradient(180deg, transparent, color-mix(in oklab, var(--color-brand-cyan) 45%, transparent), transparent)",
          }}
        />
      </div>
    );
  }
  if (index === 2) {
    return (
      <span
        className={`grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br text-white ${accent}`}
      >
        <motion.span
          animate={{ rotate: [0, -12, 12, -8, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut", repeatDelay: 0.6 }}
        >
          <Icon className="h-9 w-9" />
        </motion.span>
      </span>
    );
  }
  return (
    <div className="relative">
      <span
        className={`grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br text-white ${accent}`}
      >
        <DriveGlyph className="h-9 w-9" />
      </span>
      <motion.span
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="absolute -bottom-2 -left-2 grid h-9 w-9 place-items-center rounded-full bg-brand-emerald text-white shadow-card"
      >
        <CheckCheck className="h-5 w-5" />
      </motion.span>
    </div>
  );
}
