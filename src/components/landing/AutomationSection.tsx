"use client";

import { useRef } from "react";
import { motion, useScroll } from "framer-motion";
import { CheckCircle2, FileStack, Inbox, MailWarning, SendHorizonal } from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";

const TIMELINE = [
  {
    time: "09:00",
    text: "בקשת מסמכים נשלחה ללקוח",
    Icon: SendHorizonal,
    tone: "text-brand-purple bg-brand-purple/10",
  },
  {
    time: "11:24",
    text: "3 מסמכים התקבלו בוואטסאפ",
    Icon: Inbox,
    tone: "text-whatsapp bg-whatsapp/10",
  },
  {
    time: "11:25",
    text: "2 מסמכים סווגו ונשמרו אוטומטית",
    Icon: FileStack,
    tone: "text-brand-blue bg-brand-blue/10",
  },
  {
    time: "11:26",
    text: "זוהה חוסר: דף בנק לחודש יוני",
    Icon: MailWarning,
    tone: "text-warning bg-warning/10",
  },
  {
    time: "יומיים לאחר מכן",
    text: "תזכורת אדיבה נשלחה ללקוח אוטומטית",
    Icon: CheckCircle2,
    tone: "text-brand-emerald bg-brand-emerald/10",
  },
];

export default function AutomationSection() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.75", "end 0.6"],
  });

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
          <span dir="ltr" className="inline-block">
            Centro
          </span>{" "}
          ממשיך לעבוד גם כשאתם לא.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          כל פעולה מתועדת בזמן אמת, כדי שתמיד תדעו בדיוק מה קרה ומתי.
        </motion.p>
      </div>

      <div ref={ref} className="relative mx-auto mt-16 max-w-lg px-4 sm:px-6">
        <div className="absolute top-1 bottom-1 w-px bg-border" style={{ insetInlineEnd: "1.6rem" }} aria-hidden="true">
          <motion.div
            style={{ scaleY: scrollYProgress, transformOrigin: "top" }}
            className="h-full w-full bg-gradient-to-b from-brand-purple via-brand-blue to-brand-emerald"
          />
        </div>

        <ul className="flex flex-col gap-8">
          {TIMELINE.map((item, i) => (
            <motion.li
              key={item.text}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewportOnce}
              transition={{
                delay: i * 0.06,
                duration: 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative flex items-start gap-4"
            >
              <span
                className={`relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-full ring-4 ring-background ${item.tone}`}
              >
                <item.Icon className="h-5 w-5" />
              </span>
              <div className="flex-1 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm">
                <p className="text-sm font-semibold text-text-primary">
                  {item.text}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">{item.time}</p>
              </div>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
