"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, FolderCheck, ScanLine } from "lucide-react";
import { WhatsAppGlyph, DriveGlyph, PDFGlyph } from "./icons/IntegrationIcons";
import { CentroMark } from "./icons/CentroMark";

function CentroNode({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-2xl ring-1 ring-white/70 shadow-glow-purple ${className}`}
      style={{
        background:
          "linear-gradient(155deg, color-mix(in oklab, var(--color-brand-purple) 14%, white), color-mix(in oklab, var(--color-brand-blue) 14%, white))",
      }}
    >
      <CentroMark className="h-[65%] w-[65%]" title="Centro" />
    </span>
  );
}

const STAGES = [
  "message",
  "extract",
  "scan",
  "classify",
  "store",
  "done",
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_DURATIONS: Record<Stage, number> = {
  message: 2200,
  extract: 1800,
  scan: 2400,
  classify: 2600,
  store: 1800,
  done: 2200,
};

export default function DocumentFlowAnimation() {
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState<Stage>("message");

  useEffect(() => {
    const idx = STAGES.indexOf(stage);
    const t = setTimeout(() => {
      setStage(STAGES[(idx + 1) % STAGES.length]);
    }, STAGE_DURATIONS[stage]);
    return () => clearTimeout(t);
  }, [stage]);

  return (
    <div className="relative flex h-full w-full flex-col justify-between overflow-hidden rounded-[1.4rem] bg-gradient-to-b from-surface-muted/60 to-white p-4">
      <StageLabel stage={stage} />
      <div className="relative flex flex-1 items-center justify-center py-2">
        <AnimatePresence mode="wait">
          {stage === "message" && (
            <StageShell key="message">
              <MessageStage reduceMotion={!!reduceMotion} />
            </StageShell>
          )}
          {stage === "extract" && (
            <StageShell key="extract">
              <ExtractStage reduceMotion={!!reduceMotion} />
            </StageShell>
          )}
          {stage === "scan" && (
            <StageShell key="scan">
              <ScanStage reduceMotion={!!reduceMotion} />
            </StageShell>
          )}
          {stage === "classify" && (
            <StageShell key="classify">
              <ClassifyStage />
            </StageShell>
          )}
          {stage === "store" && (
            <StageShell key="store">
              <StoreStage reduceMotion={!!reduceMotion} />
            </StageShell>
          )}
          {stage === "done" && (
            <StageShell key="done">
              <DoneStage />
            </StageShell>
          )}
        </AnimatePresence>
      </div>
      <ProgressDots stage={stage} />
    </div>
  );
}

function StageShell({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="flex w-full items-center justify-center"
    >
      {children}
    </motion.div>
  );
}

const STAGE_TEXT: Record<Stage, string> = {
  message: "הודעה חדשה מהלקוח",
  extract: "מוציא את הקובץ המצורף",
  scan: "סורק את המסמך",
  classify: "מסווג ומזהה תקופה",
  store: "שומר בתיקייה הנכונה",
  done: "האיסוף הושלם",
};

function StageLabel({ stage }: { stage: Stage }) {
  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-1.5">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-emerald opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-emerald" />
        </span>
        <span className="text-xs font-medium text-text-secondary">
          Centro פעיל
        </span>
      </div>
      <AnimatePresence mode="wait">
        <motion.span
          key={stage}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="text-[11px] font-medium text-text-muted"
        >
          {STAGE_TEXT[stage]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

function ProgressDots({ stage }: { stage: Stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <div className="flex items-center justify-center gap-1.5 pt-2" aria-hidden="true">
      {STAGES.map((s, i) => (
        <span
          key={s}
          className="h-1 rounded-full transition-all duration-500"
          style={{
            width: i === idx ? 18 : 6,
            backgroundColor:
              i === idx
                ? "var(--color-brand-purple)"
                : "var(--color-border)",
          }}
        />
      ))}
    </div>
  );
}

function ChatBubble() {
  return (
    <div className="flex items-start gap-2 rounded-2xl rounded-tl-sm bg-[#e9fdf1] px-3 py-2 shadow-sm">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-whatsapp text-white shadow-[0_3px_10px_-2px_rgba(37,211,102,0.6)] ring-1 ring-white/70">
        <WhatsAppGlyph className="h-3.5 w-3.5" />
      </span>
      <div className="max-w-[11rem]">
        <p className="text-[11px] leading-snug text-text-primary">
          מצורפות החשבוניות של יוני 👍
        </p>
        <div className="mt-1.5 flex items-center gap-1 rounded-lg bg-white/80 px-1.5 py-1">
          <PDFGlyph className="h-4 w-4 text-pdf" />
          <span className="text-[9px] text-text-muted">חשבונית.pdf</span>
        </div>
      </div>
    </div>
  );
}

function MessageStage({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.div
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <ChatBubble />
    </motion.div>
  );
}

function ExtractStage({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div className="relative flex w-full items-center justify-between px-2">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-whatsapp/15 text-whatsapp ring-1 ring-whatsapp/20">
        <WhatsAppGlyph className="h-5 w-5" />
      </span>
      <div className="relative h-px flex-1 mx-3 bg-border">
        <motion.div
          className="absolute -top-2.5 grid h-5 w-5 place-items-center rounded-lg bg-white shadow-card"
          initial={reduceMotion ? { left: "50%" } : { left: "0%" }}
          animate={{ left: "92%" }}
          transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1] }}
          style={{ translateX: "-50%" }}
        >
          <PDFGlyph className="h-3.5 w-3.5 text-pdf" />
        </motion.div>
      </div>
      <CentroNode />
    </div>
  );
}

function ScanStage({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div className="relative h-24 w-20 overflow-hidden rounded-lg border border-border bg-white shadow-card">
      <div className="space-y-1.5 p-2">
        {[100, 80, 90, 60, 75].map((w, i) => (
          <div
            key={i}
            className="h-1.5 rounded-full bg-surface-muted"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
      {!reduceMotion && (
        <motion.div
          className="absolute inset-x-0 h-6"
          style={{
            background:
              "linear-gradient(180deg, transparent, color-mix(in oklab, var(--color-brand-cyan) 35%, transparent), transparent)",
          }}
          initial={{ top: "-20%" }}
          animate={{ top: "100%" }}
          transition={{ duration: 1.4, repeat: 1, ease: "linear" }}
        />
      )}
      <ScanLine className="absolute bottom-1.5 left-1.5 h-3.5 w-3.5 text-brand-cyan" />
    </div>
  );
}

function ClassifyStage() {
  const tags = [
    { label: "סוג: חשבונית הוצאה", delay: 0 },
    { label: "תקופה: יוני 2026", delay: 0.35 },
    { label: "ביטחון: 98%", delay: 0.7 },
  ];
  return (
    <div className="flex w-full flex-col items-start gap-1.5 px-3">
      {tags.map((t) => (
        <motion.span
          key={t.label}
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: t.delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-full border border-border bg-white px-2.5 py-1 text-[10px] font-medium text-text-secondary shadow-sm"
        >
          {t.label}
        </motion.span>
      ))}
      <motion.span
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 1.1, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mt-1 flex items-center gap-1 text-[10px] font-medium text-brand-emerald"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        זוהה בהצלחה
      </motion.span>
    </div>
  );
}

function StoreStage({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div className="relative flex w-full items-center justify-between px-2">
      <CentroNode />
      <div className="relative h-px flex-1 mx-3 bg-border">
        <motion.div
          className="absolute -top-2.5 grid h-5 w-5 place-items-center rounded-lg bg-white shadow-card"
          initial={reduceMotion ? { left: "50%" } : { left: "8%" }}
          animate={{ left: "92%" }}
          transition={{ duration: 1.3, ease: [0.22, 1, 0.36, 1] }}
          style={{ translateX: "-50%" }}
        >
          <PDFGlyph className="h-3.5 w-3.5 text-pdf" />
        </motion.div>
      </div>
      <span className="grid h-9 w-9 place-items-center rounded-full bg-drive/15 text-drive ring-1 ring-drive/20">
        <DriveGlyph className="h-5 w-5" />
      </span>
    </div>
  );
}

function DoneStage() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="flex w-full flex-col items-center gap-2 rounded-xl border border-border bg-white px-4 py-3 shadow-card"
    >
      <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-emerald/15 text-brand-emerald">
        <FolderCheck className="h-5 w-5" />
      </span>
      <div className="text-center">
        <p className="text-xs font-semibold text-text-primary">מסמך התקבל ונשמר בתיקייה</p>
        <p className="mt-0.5 text-[10px] text-text-muted">חשבוניות יוני 2026</p>
      </div>
      <div className="flex w-full items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <motion.div
            className="h-full rounded-full bg-gradient-to-l from-brand-purple to-brand-cyan"
            initial={{ width: "0%" }}
            animate={{ width: "100%" }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <span className="text-[10px] font-semibold text-brand-emerald">100%</span>
      </div>
    </motion.div>
  );
}
