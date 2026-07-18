"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import {
  Bell,
  FileWarning,
  Mail,
  MessageCircleMore,
  FileSpreadsheet,
  FolderX,
} from "lucide-react";
import { fadeUp, viewportOnce } from "@/lib/motion";
import { useResponsiveScale } from "@/lib/useResponsiveScale";

type Chip = {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  chaos: { x: number; y: number; rotate: number };
  order: { x: number; y: number };
  tone: string;
};

const CHIPS: Chip[] = [
  {
    icon: MessageCircleMore,
    text: "מתי תשלחו את החשבוניות?",
    chaos: { x: -150, y: -70, rotate: -10 },
    order: { x: -220, y: -64 },
    tone: "text-whatsapp bg-whatsapp/10",
  },
  {
    icon: Bell,
    text: "תזכורת שלישית נשלחה",
    chaos: { x: 130, y: -110, rotate: 8 },
    order: { x: 0, y: -64 },
    tone: "text-warning bg-warning/10",
  },
  {
    icon: Mail,
    text: "קובץ מצורף בג׳ימייל",
    chaos: { x: 190, y: 40, rotate: -6 },
    order: { x: 220, y: -64 },
    tone: "text-gmail bg-gmail/10",
  },
  {
    icon: FileSpreadsheet,
    text: "גיליון נתונים ישן",
    chaos: { x: -190, y: 90, rotate: 12 },
    order: { x: -220, y: 20 },
    tone: "text-excel bg-excel/10",
  },
  {
    icon: FolderX,
    text: "תיקייה לא מסודרת",
    chaos: { x: 30, y: 130, rotate: -14 },
    order: { x: 0, y: 20 },
    tone: "text-brand-coral bg-brand-coral/10",
  },
  {
    icon: FileWarning,
    text: "חסר דף בנק ליוני",
    chaos: { x: 160, y: 150, rotate: 9 },
    order: { x: 220, y: 20 },
    tone: "text-danger bg-danger/10",
  },
];

function ChaosChip({
  chip,
  progress,
  spread,
}: {
  chip: Chip;
  progress: import("framer-motion").MotionValue<number>;
  spread: number;
}) {
  const reduceMotion = useReducedMotion();
  const x = useTransform(
    progress,
    [0, 1],
    [chip.chaos.x * spread, chip.order.x * spread]
  );
  const y = useTransform(
    progress,
    [0, 1],
    [chip.chaos.y * spread, chip.order.y * spread]
  );
  const rotate = useTransform(progress, [0, 1], [chip.chaos.rotate, 0]);
  const opacity = useTransform(progress, [0, 0.15, 1], [0.55, 1, 1]);

  const Icon = chip.icon;

  return (
    <motion.div
      style={
        reduceMotion
          ? { x: chip.order.x * spread, y: chip.order.y * spread }
          : { x, y, rotate, opacity }
      }
      className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-2xl border border-border bg-white px-3.5 py-2.5 shadow-card"
    >
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${chip.tone}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="whitespace-nowrap text-sm font-medium text-text-secondary">
        {chip.text}
      </span>
    </motion.div>
  );
}

export default function ProblemSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start 0.85", "start 0.15"],
  });
  const spread = useResponsiveScale(0.6, 0.88, 1);

  return (
    <section className="relative overflow-hidden py-24 sm:py-32" ref={sectionRef}>
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.h2
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="text-balance text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight tracking-tight text-text-primary"
        >
          איסוף מסמכים לא צריך לנהל לכם את היום.
        </motion.h2>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
          className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
        >
          הודעות, תזכורות, קבצים ותיקיות מפוזרות הופכים לתהליך אחד אוטומטי
          וברור.
        </motion.p>
      </div>

      <div className="relative mx-auto mt-16 h-[22rem] max-w-3xl sm:h-80">
        {CHIPS.map((chip, i) => (
          <ChaosChip key={i} chip={chip} progress={scrollYProgress} spread={spread} />
        ))}
      </div>
    </section>
  );
}
