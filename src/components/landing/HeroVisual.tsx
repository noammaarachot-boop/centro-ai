"use client";

import { useRef } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import OrbitingIntegrations from "./OrbitingIntegrations";
import DocumentFlowAnimation from "./DocumentFlowAnimation";
import { useResponsiveScale } from "@/lib/useResponsiveScale";

export default function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const orbitSpread = useResponsiveScale(0.7, 0.86, 1);

  const mvX = useMotionValue(0);
  const mvY = useMotionValue(0);
  const springX = useSpring(mvX, { stiffness: 60, damping: 18 });
  const springY = useSpring(mvY, { stiffness: 60, damping: 18 });

  const rotateX = useTransform(springY, [-0.5, 0.5], [6, -6]);
  const rotateY = useTransform(springX, [-0.5, 0.5], [-8, 8]);
  const shiftX = useTransform(springX, [-0.5, 0.5], [-10, 10]);
  const shiftY = useTransform(springY, [-0.5, 0.5], [-10, 10]);

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (reduceMotion || e.pointerType !== "mouse") return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    mvX.set((e.clientX - rect.left) / rect.width - 0.5);
    mvY.set((e.clientY - rect.top) / rect.height - 0.5);
  }

  function handlePointerLeave() {
    mvX.set(0);
    mvY.set(0);
  }

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className="relative mx-auto aspect-square w-full max-w-[420px]"
      style={{ perspective: 1000 }}
    >
      {/* ambient glow */}
      <div
        aria-hidden="true"
        className="absolute inset-[6%] rounded-full blur-3xl"
        style={{ background: "var(--gradient-hero)", opacity: 0.32 }}
      />

      <OrbitingIntegrations spread={orbitSpread} />

      <motion.div
        style={
          reduceMotion
            ? undefined
            : { rotateX, rotateY, x: shiftX, y: shiftY, transformStyle: "preserve-3d" }
        }
        className="absolute inset-0 grid place-items-center"
      >
        {/* backdrop-blur is desktop-only: on mobile Safari, backdrop-filter
            creates a compositing layer that renders this card's own
            transform-animated children (the flying PDF icon in
            DocumentFlowAnimation) behind the blur instead of above it. The
            blur is barely visible on a card this small and opaque anyway. */}
        <div className="relative h-[15.5rem] w-[15.5rem] rounded-[1.75rem] border border-white/60 bg-white p-3 shadow-card-lg sm:bg-white/95 sm:backdrop-blur-md sm:h-64 sm:w-64">
          <DocumentFlowAnimation />
        </div>
      </motion.div>
    </div>
  );
}
