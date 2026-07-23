"use client";

import { motion } from "framer-motion";
import {
  Eye,
  KeyRound,
  Lock,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { DriveGlyph } from "./icons/IntegrationIcons";
import { fadeUp, staggerContainer, viewportOnce } from "@/lib/motion";
import TrialCta from "./TrialCta";

const TRUST_ITEMS = [
  {
    Icon: Lock,
    title: "חיבורים מאובטחים",
    desc: "כל התקשורת בין Centro לשירותים שלכם מוצפנת ומבוקרת.",
  },
  {
    Icon: KeyRound,
    title: "הרשאות מדויקות",
    desc: "כל משתמש במשרד רואה ועושה רק את מה שהוגדר לו.",
  },
  {
    Icon: Eye,
    title: "שקיפות מלאה",
    desc: "כל פעולה של Centro מתועדת, ואפשר לבדוק אותה בכל רגע נתון.",
  },
  {
    Icon: DriveGlyph,
    title: "הקבצים שלכם, אצלכם",
    desc: "המסמכים נשמרים במרחב האחסון שלכם בגוגל דרייב — לא אצלנו.",
  },
  {
    Icon: UserCheck,
    title: "בקרה אנושית כשצריך",
    desc: "כשמשהו לא ברור מספיק, Centro מעביר את הבדיקה לצוות שלכם.",
  },
  {
    Icon: ShieldCheck,
    title: "נבנה מתוך אחריות",
    desc: "אבטחה, הרשאות ושקיפות הן חלק מהתכנון — לא תוספת בדיעבד.",
  },
];

export default function TrustSection() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.span
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-sm font-semibold uppercase tracking-wide text-brand-purple"
        >
          אבטחה ואמון
        </motion.span>
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mt-3 text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          נבנה מתוך מחשבה על אבטחה, הרשאות ושקיפות.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          Centro מטפל במסמכים רגישים, ולכן כל החלטת עיצוב מתחילה בשאלה: מי
          רואה מה, ולמה.
        </motion.p>
      </div>

      <motion.div
        variants={staggerContainer(0.08)}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3"
      >
        {TRUST_ITEMS.map((item) => (
          <motion.div
            key={item.title}
            variants={fadeUp}
            className="rounded-2xl border border-border bg-white p-5 text-right shadow-sm"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-purple/10 text-brand-purple">
              <item.Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-3 text-base font-semibold text-text-primary">
              {item.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
              {item.desc}
            </p>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-8 max-w-3xl px-4 sm:px-6"
      >
        <div
          className="rounded-[1.75rem] p-8 text-center shadow-card-lg sm:p-10"
          style={{ background: "var(--gradient-hero)" }}
        >
          <p className="text-lg font-semibold leading-relaxed text-white sm:text-xl">
            מתאים לכל עסק שאוסף מסמכים מלקוחות כחלק מתהליך העבודה שלו.
          </p>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/85">
            תנו ל־Centro לרדוף במקומכם — 14 יום להתנסות, בלי לשנות שום דבר
            אחר בעבודה השוטפת שלכם.
          </p>
          <div className="mt-6 flex justify-center">
            <TrialCta variant="inverse" />
          </div>
        </div>
      </motion.div>
    </section>
  );
}
