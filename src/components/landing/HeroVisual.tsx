"use client";

import { useLayoutEffect, useRef, useState } from "react";
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

// A real gap the orbit icons must clear beyond the card's own corner.
const ORBIT_GAP_PX = 16;
// Below this container width, the tuned desktop/tablet radii (spread
// scaled) can no longer be trusted to clear the card at all — the card
// stays roughly the same physical size across breakpoints while spread
// shrinks, so below this width the radius is instead derived from real
// measurements (see recalcOrbitBounds below).
const MEASURE_BELOW_PX = 640;

export default function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const orbitSpread = useResponsiveScale(0.7, 0.86, 1);
  // Icon size, scaled separately from (smaller than) position on mobile
  // only: each icon's own half-size is subtracted from the radius clamp
  // twice over (once against the visibility ceiling, once against the
  // clearance floor), so a slightly smaller icon frees up real orbit
  // room on the narrowest phones. Matches `orbitSpread` at tablet/
  // desktop, so nothing changes there.
  const orbitIconSizeScale = useResponsiveScale(0.55, 0.86, 1);

  // On mobile, the card's own half-diagonal (the true worst-case
  // clearance distance for a circular orbit around a square card) often
  // exceeds half the available container width — there is no radius
  // that both fully clears the card's corners AND stays fully visible
  // within the viewport. When that happens, visibility wins: the clamp
  // below prefers "fully visible, occasionally close to the card" over
  // "guaranteed clear, partially clipped off-screen." Measured from the
  // real DOM (like TestimonialsSection's marquee) rather than assumed,
  // since the container width varies by device and the card's own
  // rendered size can shift with the user's own accessibility font-size
  // setting.
  const [orbitBounds, setOrbitBounds] = useState<{ min: number; max: number } | null>(null);

  useLayoutEffect(() => {
    function recalcOrbitBounds() {
      const containerWidth = containerRef.current?.offsetWidth ?? 0;
      const cardWidth = cardRef.current?.offsetWidth ?? 0;
      if (!containerWidth || !cardWidth || containerWidth >= MEASURE_BELOW_PX) {
        setOrbitBounds(null); // tablet/desktop: fall back to the tuned static radii, untouched
        return;
      }
      const cardHalfDiagonal = (cardWidth / 2) * Math.SQRT2;
      setOrbitBounds({
        min: cardHalfDiagonal + ORBIT_GAP_PX,
        max: containerWidth / 2,
      });
    }

    recalcOrbitBounds();
    const ro = new ResizeObserver(recalcOrbitBounds);
    if (containerRef.current) ro.observe(containerRef.current);
    if (cardRef.current) ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, []);

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
      {/* Ambient glow — a multi-stop radial gradient, not a blurred solid
          shape (blur has a real, if soft, edge once it drops below a
          visible threshold, which read as a hard seam on mobile).
          `farthest-side` is required: this div's box is a square, and a
          bare `circle` gradient defaults to `farthest-corner` sizing, so
          straight down — where this glow meets the next section — the
          gradient was still ~8% opaque at the box's own edge and got
          clipped there. `farthest-side` reaches 0% opacity before any
          edge, in every direction. Same brand colors as --gradient-hero
          elsewhere on this page, expressed as an explicit radial fade. */}
      <div
        aria-hidden="true"
        className="absolute -inset-[25%]"
        style={{
          background:
            "radial-gradient(circle farthest-side, color-mix(in oklab, var(--color-brand-purple) 30%, transparent) 0%, color-mix(in oklab, var(--color-brand-blue) 18%, transparent) 45%, color-mix(in oklab, var(--color-brand-cyan) 8%, transparent) 70%, transparent 100%)",
        }}
      />

      <OrbitingIntegrations
        spread={orbitSpread}
        sizeScale={orbitIconSizeScale}
        minRadius={orbitBounds?.min}
        maxRadius={orbitBounds?.max}
      />

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
        <div
          ref={cardRef}
          className="relative h-[15.5rem] w-[15.5rem] rounded-[1.75rem] border border-white/60 bg-white p-3 shadow-card-lg sm:bg-white/95 sm:backdrop-blur-md sm:h-64 sm:w-64"
        >
          <DocumentFlowAnimation />
        </div>
      </motion.div>
    </div>
  );
}
