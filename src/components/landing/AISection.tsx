"use client";

import { motion, useReducedMotion } from "framer-motion";
import { BadgeCheck, CopyCheck, FileSearch, ShieldCheck } from "lucide-react";
import { fadeUp, staggerContainer, viewportOnce } from "@/lib/motion";

const CHECKS = [
  { icon: FileSearch, label: "סוג מסמך", value: "חשבונית הוצאה" },
  { icon: BadgeCheck, label: "תקופה מזוהה", value: "יוני 2026" },
  { icon: CopyCheck, label: "בדיקת כפילות", value: "לא נמצאה כפילות" },
  { icon: ShieldCheck, label: "תוצאת בדיקה", value: "תקין להעברה" },
];

export default function AISection() {
  const reduceMotion = useReducedMotion();

  return (
    <section id="capabilities" className="relative py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:gap-10">
        <motion.div
          variants={staggerContainer(0.1)}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="order-2 text-center lg:order-1 lg:text-right"
        >
          <motion.span
            variants={fadeUp}
            className="text-sm font-semibold uppercase tracking-wide text-brand-blue"
          >
            <span dir="ltr" className="inline-block">
              AI
            </span>{" "}
            שמבין מסמכים
          </motion.span>
          <motion.h2
            variants={fadeUp}
            className="mt-3 text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
          >
            לא רק מקבל מסמכים. מבין אותם.
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="mx-auto mt-5 max-w-md text-pretty text-lg leading-relaxed text-text-secondary lg:mx-0"
          >
            Centro מזהה מה נשלח, לאיזו תקופה הוא שייך, האם הוא כפול ומה
            עדיין חסר — לפני שמישהו במשרד הספיק לפתוח את הקובץ.
          </motion.p>

          <motion.dl
            variants={staggerContainer(0.08, 0.1)}
            className="mx-auto mt-8 grid max-w-md grid-cols-2 gap-3 lg:mx-0"
          >
            {CHECKS.map((c) => (
              <motion.div
                key={c.label}
                variants={fadeUp}
                className="flex items-start gap-2.5 rounded-2xl border border-border bg-white p-3.5 text-right shadow-sm"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-blue/10 text-brand-blue">
                  <c.icon className="h-4 w-4" />
                </span>
                <span>
                  <dt className="text-xs text-text-muted">{c.label}</dt>
                  <dd className="text-sm font-semibold text-text-primary">
                    {c.value}
                  </dd>
                </span>
              </motion.div>
            ))}
          </motion.dl>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={viewportOnce}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="order-1 flex justify-center lg:order-2"
        >
          <AnalysisCard reduceMotion={!!reduceMotion} />
        </motion.div>
      </div>
    </section>
  );
}

function AnalysisCard({ reduceMotion }: { reduceMotion: boolean }) {
  const lineWidths = [88, 62, 74, 40, 55, 70];

  return (
    <div className="relative w-full max-w-sm rounded-[2rem] border border-white/70 bg-white p-5 shadow-card-lg">
      <div className="relative overflow-hidden rounded-xl border border-border bg-surface-muted/60 p-4">
        <div className="space-y-2">
          {lineWidths.map((w, i) => (
            <motion.div
              key={i}
              initial={reduceMotion ? false : { scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={viewportOnce}
              transition={{
                delay: 0.15 + i * 0.08,
                duration: 0.4,
                ease: [0.22, 1, 0.36, 1],
              }}
              style={{ transformOrigin: "right", width: `${w}%` }}
              className="h-2 rounded-full bg-border"
            />
          ))}
        </div>
        {!reduceMotion && (
          <motion.div
            initial={{ top: "-15%" }}
            whileInView={{ top: "110%" }}
            viewport={viewportOnce}
            transition={{ delay: 0.2, duration: 1.6, ease: "linear" }}
            className="pointer-events-none absolute inset-x-0 h-10"
            style={{
              background:
                "linear-gradient(180deg, transparent, color-mix(in oklab, var(--color-brand-cyan) 30%, transparent), transparent)",
            }}
          />
        )}
      </div>

      <motion.div
        variants={staggerContainer(0.12, 0.9)}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mt-4 space-y-2"
      >
        {CHECKS.map((c) => (
          <motion.div
            key={c.label}
            variants={fadeUp}
            className="flex items-center justify-between rounded-lg bg-surface-muted/70 px-3 py-2"
          >
            <span className="text-xs font-medium text-text-secondary">
              {c.label}
            </span>
            <span className="flex items-center gap-1 text-xs font-semibold text-brand-emerald">
              <BadgeCheck className="h-3.5 w-3.5" />
              {c.value}
            </span>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={viewportOnce}
        transition={{ delay: 1.4, duration: 0.4 }}
        className="mt-4 flex items-center gap-3 rounded-xl bg-gradient-to-l from-brand-purple/10 to-brand-cyan/10 px-3.5 py-2.5"
      >
        <span className="text-xs font-medium text-text-secondary">
          רמת ביטחון
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
          <motion.div
            initial={{ width: "0%" }}
            whileInView={{ width: "98%" }}
            viewport={viewportOnce}
            transition={{ delay: 1.5, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="h-full rounded-full bg-gradient-to-l from-brand-purple to-brand-cyan"
          />
        </div>
        <span className="text-xs font-bold text-text-primary">98%</span>
      </motion.div>
    </div>
  );
}
