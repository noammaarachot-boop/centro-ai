"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Clock3, Sparkles } from "lucide-react";
import { fadeUp, staggerContainer, viewportOnce } from "@/lib/motion";
import { CentroMark } from "./icons/CentroMark";

const WAITING_CLIENTS = [
  { name: "לקוח א׳ — עוסק מורשה", status: "ממתין ל־2 קבצים" },
  { name: "לקוח ב׳ — חברה בע״מ", status: "ממתין לדף בנק" },
  { name: "לקוח ג׳ — עצמאי", status: "כל הקבצים התקבלו" },
];

const AI_FEED = [
  "זיהיתי שחסר דף הבנק של יוני.",
  "שלחתי ללקוח תזכורת לפני שעה.",
  "7 מסמכים התקבלו ונשמרו אוטומטית.",
];

export default function DashboardPreviewSection() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          תמונה אחת ברורה של כל מה שקורה.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          תצוגה חלקית מלוח הבקרה של Centro — הכול מסודר, מעודכן, וברור
          במבט אחד.
        </motion.p>
      </div>

      <motion.div
        variants={staggerContainer(0.1)}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-14 max-w-4xl px-4 sm:px-6"
      >
        <div className="rounded-[1.75rem] border border-white/70 bg-white/90 p-3 shadow-card-lg backdrop-blur-xl sm:p-4">
          <div className="flex items-center justify-between rounded-2xl bg-surface-muted/70 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <CentroMark className="h-6 w-6" title="Centro" />
              לוח הבקרה של Centro
            </span>
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-emerald opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-emerald" />
              </span>
              מתעדכן בזמן אמת
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-6">
            {/* Completion */}
            <motion.div
              variants={fadeUp}
              className="col-span-1 rounded-2xl border border-border p-4 sm:col-span-2"
            >
              <p className="text-xs text-text-muted">אחוז השלמה החודש</p>
              <p className="mt-1 text-3xl font-extrabold text-text-primary">78%</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <motion.div
                  initial={{ width: "0%" }}
                  whileInView={{ width: "78%" }}
                  viewport={viewportOnce}
                  transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
                  className="h-full rounded-full bg-gradient-to-l from-brand-purple to-brand-cyan"
                />
              </div>
            </motion.div>

            {/* Waiting clients */}
            <motion.div
              variants={fadeUp}
              className="col-span-1 rounded-2xl border border-border p-4 sm:col-span-2"
            >
              <p className="mb-2 text-xs text-text-muted">לקוחות שממתינים למסמכים</p>
              <ul className="space-y-2">
                {WAITING_CLIENTS.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-text-primary">
                      {c.name}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        c.status === "כל הקבצים התקבלו"
                          ? "bg-brand-emerald/10 text-brand-emerald"
                          : "bg-warning/10 text-warning"
                      }`}
                    >
                      {c.status}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* AI feed */}
            <motion.div
              variants={fadeUp}
              className="col-span-1 rounded-2xl border border-border p-4 sm:col-span-2"
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs text-text-muted">
                <Sparkles className="h-3.5 w-3.5 text-brand-purple" />
                יומן פעילות
              </p>
              <ul className="space-y-2">
                {AI_FEED.map((msg) => (
                  <li
                    key={msg}
                    className="rounded-lg bg-surface-muted/70 px-2.5 py-1.5 text-[11px] leading-snug text-text-secondary"
                  >
                    {msg}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* Human attention */}
            <motion.div
              variants={fadeUp}
              className="col-span-1 flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning/5 p-4 sm:col-span-3"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">
                  דורש בדיקה ידנית
                </p>
                <p className="text-xs text-text-secondary">
                  מסמך אחד לא ברור מספיק לסיווג אוטומטי
                </p>
              </div>
            </motion.div>

            {/* Recently processed */}
            <motion.div
              variants={fadeUp}
              className="col-span-1 flex items-center gap-3 rounded-2xl border border-border p-4 sm:col-span-3"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-blue/10 text-brand-blue">
                <Clock3 className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">
                  עודכן לפני 4 דקות
                </p>
                <p className="text-xs text-text-secondary">
                  חשבונית.pdf סווגה ונשמרה בתיקיית יוני
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
