"use client";

import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { fadeUp, staggerContainer, viewportOnce } from "@/lib/motion";

const FAQS = [
  {
    q: "האם Centro מחליף את הצוות שלנו?",
    a: "לא. Centro מטפל באיסוף השוטף והחוזר של מסמכים, כדי שהצוות שלכם יתפנה לעבודה המקצועית שבאמת דורשת שיקול דעת.",
  },
  {
    q: "איך Centro מתחבר לוואטסאפ, ג׳ימייל וגוגל דרייב?",
    a: "דרך חיבורים מאובטחים לכלים שכבר נמצאים בשימוש במשרד ובקרב הלקוחות שלכם — בלי להחליף אותם ובלי לדרוש הרגלים חדשים.",
  },
  {
    q: "מה קורה כשמסמך לא ברור ל־AI?",
    a: "Centro לא מנחש. כשרמת הביטחון בזיהוי נמוכה מדי, המסמך מסומן לבדיקה אנושית והצוות שלכם מקבל התראה ברורה.",
  },
  {
    q: "אפשר לשלוט במה ש־Centro שולח ללקוחות?",
    a: "כן. ניתן להגדיר את הטון, התזמון והתוכן של ההודעות, כך שהתקשורת עם הלקוחות תישאר תחת השליטה שלכם.",
  },
  {
    q: "כמה זמן לוקח להטמיע את Centro במשרד?",
    a: "אנחנו בשלב פיילוט, ובונים כל הטמעה יחד עם המשרד. פרטים מדויקים לגבי לוחות זמנים נסגרים בפגישת ההדגמה.",
  },
];

export default function FAQSection() {
  return (
    <section id="faq" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-2xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          שאלות נפוצות
        </motion.h2>
      </div>

      <motion.div
        variants={staggerContainer(0.06)}
        initial="hidden"
        whileInView="show"
        viewport={viewportOnce}
        className="mx-auto mt-10 max-w-2xl px-4 sm:px-6"
      >
        <div className="divide-y divide-border rounded-2xl border border-border bg-white shadow-sm">
          {FAQS.map((item) => (
            <motion.details
              key={item.q}
              variants={fadeUp}
              className="group px-5 py-4 open:pb-5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-1 text-right text-base font-semibold text-text-primary marker:content-none">
                {item.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-text-muted transition-transform duration-300 group-open:rotate-180" />
              </summary>
              <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">
                {item.a}
              </p>
            </motion.details>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
