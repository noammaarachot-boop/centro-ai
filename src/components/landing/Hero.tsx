"use client";

import { motion } from "framer-motion";
import { ArrowLeft, PlayCircle } from "lucide-react";
import HeroVisual from "./HeroVisual";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { CentroMark } from "./icons/CentroMark";

export default function Hero() {
  return (
    <section
      id="top"
      className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "var(--gradient-mesh)" }}
      />

      <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-16 px-4 sm:px-6 lg:grid-cols-2 lg:gap-8">
        <motion.div
          variants={staggerContainer(0.12)}
          initial="hidden"
          animate="show"
          className="text-center lg:text-right"
        >
          <motion.span
            variants={fadeUp}
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-white px-4 py-1.5 text-sm font-medium text-text-secondary shadow-sm"
          >
            <CentroMark className="h-4 w-4" title="Centro" />
            <span className="h-1.5 w-1.5 rounded-full bg-brand-emerald" />
            העובד הדיגיטלי לאיסוף מסמכים
          </motion.span>

          <motion.h1
            variants={fadeUp}
            className="text-balance text-[clamp(2.25rem,5.5vw,3.75rem)] font-extrabold leading-[1.12] tracking-tight text-text-primary"
          >
            תפסיקו לרדוף אחרי מסמכים.
            <br />
            <span className="bg-gradient-to-l from-brand-purple via-brand-blue to-brand-cyan bg-clip-text text-transparent">
              <span dir="ltr" className="inline-block">
                Centro
              </span>{" "}
              כבר עושה את זה בשבילכם.
            </span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="mx-auto mt-6 max-w-lg text-pretty text-lg leading-relaxed text-text-secondary lg:mx-0"
          >
            העובד הדיגיטלי שאוסף מסמכים מהלקוחות, מבין מה התקבל, שולח
            תזכורות ומסדר הכול במקום הנכון.
          </motion.p>

          <motion.div
            variants={fadeUp}
            className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start"
          >
            <a
              href="#final-cta"
              className="group flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-7 py-3.5 text-base font-semibold text-white shadow-card-lg transition-transform hover:scale-[1.02] active:scale-[0.98] sm:w-auto"
            >
              בקשו הדגמה
              <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            </a>
            <a
              href="#demo"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-border bg-white px-7 py-3.5 text-base font-semibold text-text-primary transition-colors hover:bg-surface-muted sm:w-auto"
            >
              <PlayCircle className="h-5 w-5 text-brand-purple" />
              ראו את Centro בפעולה
            </a>
          </motion.div>

          <motion.p
            variants={fadeUp}
            className="mt-6 text-sm text-text-muted"
          >
            מתחבר ל־
            <span dir="ltr" className="inline-block px-1">
              WhatsApp · Gmail · Google Drive
            </span>
            ועובד מהיום הראשון.
          </motion.p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="relative"
        >
          <HeroVisual />
        </motion.div>
      </div>
    </section>
  );
}
