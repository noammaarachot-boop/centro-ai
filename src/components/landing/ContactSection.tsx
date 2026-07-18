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
            className="absolute -inset-6 -z-10 rounded-[2.5rem] opacity-30 blur-3xl"
            style={{ background: "var(--gradient-hero)" }}
          />
          <div className="rounded-[1.75rem] border border-white/70 bg-white/95 p-6 shadow-card-lg backdrop-blur-md sm:p-8">
            <ContactForm idPrefix="contact-section" />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
