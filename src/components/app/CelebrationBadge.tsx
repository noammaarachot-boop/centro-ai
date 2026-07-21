"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

const CONFETTI_COLORS = ["#3B6DFF", "#7C3AED", "#17C3D6", "#FFFFFF", "#C9972E"];
const PARTICLE_COUNT = 70;
const DURATION_MS = 1700;
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 320;

// Onboarding completion's one-time celebration — a canvas confetti burst
// (blue/purple/teal/white/gold, ~1.7s) framing the "Centro ready" badge,
// then the interface settles calm again. Runs once on mount; the
// completion step itself only ever renders once per organization
// (finishOnboarding redirects away and the step isn't reachable again),
// so no separate first-time-only flag is needed here.
export function CelebrationBadge() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const originX = CANVAS_WIDTH / 2;
    const originY = 90;
    const particles = Array.from({ length: PARTICLE_COUNT }).map(() => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        size: 3 + Math.random() * 4,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        rotation: Math.random() * Math.PI,
        rotationSpeed: (Math.random() - 0.5) * 0.3,
      };
    });

    const start = performance.now();
    let frameId: number;

    function frame(t: number) {
      const elapsed = t - start;
      const life = Math.max(0, 1 - elapsed / DURATION_MS);
      ctx!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.09;
        p.rotation += p.rotationSpeed;
        ctx!.save();
        ctx!.globalAlpha = life;
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.rotation);
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx!.restore();
      });
      if (elapsed < DURATION_MS) {
        frameId = requestAnimationFrame(frame);
      } else {
        ctx!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    }
    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <div className="relative mx-auto mb-4 grid h-[78px] w-[78px] place-items-center">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -z-0 -translate-x-1/2 -translate-y-1/2"
        style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
      />
      <span className="centro-ai-gradient relative z-[1] grid h-[78px] w-[78px] place-items-center rounded-full text-white shadow-[0_18px_40px_-14px_rgba(124,58,237,0.45)]">
        <Check className="h-[34px] w-[34px]" strokeWidth={2.4} aria-hidden="true" />
      </span>
    </div>
  );
}
