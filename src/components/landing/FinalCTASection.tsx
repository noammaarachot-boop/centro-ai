"use client";

import { motion } from "framer-motion";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { fadeUp, staggerContainer, viewportOnce } from "@/lib/motion";

export default function FinalCTASection() {
  return (
    <section id="final-cta" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <motion.div
          variants={staggerContainer(0.1)}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="relative overflow-hidden rounded-[2rem] px-6 py-16 text-center shadow-card-lg sm:px-12 sm:py-20"
          style={{ background: "var(--gradient-hero)" }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 right-1/4 h-72 w-72 rounded-full bg-white/10 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 left-1/4 h-72 w-72 rounded-full bg-white/10 blur-3xl"
          />

          <motion.h2
            variants={fadeUp}
            className="relative text-balance text-[clamp(1.9rem,4.5vw,3rem)] font-extrabold leading-tight tracking-tight text-white"
          >
            הגיע הזמן להפסיק לרדוף אחרי מסמכים.
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="relative mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-white/85"
          >
            תנו ל־
            <span dir="ltr" className="inline-block px-1">
              Centro
            </span>
            לנהל את האיסוף, כדי שאתם תוכלו להתמקד בעבודה החשובה באמת.
          </motion.p>

          <motion.div
            variants={fadeUp}
            className="relative mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <a
              href="#demo"
              className="group flex w-full items-center justify-center gap-2 rounded-full bg-white px-7 py-3.5 text-base font-semibold text-brand-purple-deep shadow-card transition-transform hover:scale-[1.02] active:scale-[0.98] sm:w-auto"
            >
              בקשו הדגמה
              <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            </a>
            <a
              href="mailto:hello@centro.example.com"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-white/30 px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-white/10 sm:w-auto"
            >
              <MessageSquare className="h-5 w-5" />
              דברו איתנו
            </a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
