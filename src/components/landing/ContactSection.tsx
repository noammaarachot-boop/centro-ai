"use client";

import { motion } from "framer-motion";
import { fadeUp, viewportOnce } from "@/lib/motion";
import ContactForm from "./ContactForm";

export default function ContactSection() {
  return (
    <section id="contact" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-xl px-4 sm:px-6">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-center"
        >
          <h2 className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary">
            מוכנים לתת ל־Centro להתחיל לעבוד בשבילכם?
          </h2>
          <p className="mx-auto mt-4 max-w-md text-pretty text-lg leading-relaxed text-text-secondary">
            השאירו פרטים ונחזור אליכם להדגמה קצרה.
          </p>
        </motion.div>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="relative mt-10"
        >
          <div
            aria-hidden="true"
            // The bleed matches the wrapper's own padding at each breakpoint
            // (px-4 below sm, px-6 from sm), so this decorative wash reaches
            // exactly the viewport edge and never past it. At a flat -inset-6
            // it overhung the 16px mobile padding by 8px, and nothing clips
            // it, so it widened the whole page on every phone — measured at
            // 398 against a 390 viewport. Same failure as .centro-live-card's
            // glow: an invisible decoration deciding the document's width.
            className="absolute -inset-4 -z-10 rounded-[2.5rem] opacity-30 blur-3xl sm:-inset-6"
            style={{ background: "var(--gradient-hero)" }}
          />
          <div className="rounded-[1.75rem] border border-white/70 bg-white/95 p-6 shadow-card-lg backdrop-blur-md sm:p-8">
            <ContactForm idPrefix="contact-section" source="עמוד הבית — טופס יצירת קשר" />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
