"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  INTEGRATION_META,
  type IntegrationKey,
} from "./icons/IntegrationIcons";

type OrbitItem = {
  type: IntegrationKey;
  radius: number;
  size: number;
  startAngle: number;
  duration: number;
  direction: 1 | -1;
  blur?: number;
  opacity?: number;
};

const DEFAULT_ITEMS: OrbitItem[] = [
  { type: "whatsapp", radius: 168, size: 58, startAngle: 20, duration: 34, direction: 1 },
  { type: "drive", radius: 190, size: 52, startAngle: 250, duration: 40, direction: 1 },
  { type: "pdf", radius: 130, size: 42, startAngle: 320, duration: 26, direction: -1, blur: 0.4, opacity: 0.9 },
  { type: "excel", radius: 205, size: 44, startAngle: 100, duration: 44, direction: -1, blur: 0.6, opacity: 0.88 },
  { type: "ai", radius: 118, size: 46, startAngle: 200, duration: 22, direction: 1 },
];

function OrbitIcon({
  item,
  spread,
  sizeScale,
  minRadius,
  maxRadius,
}: {
  item: OrbitItem;
  spread: number;
  sizeScale?: number;
  minRadius?: number;
  maxRadius?: number;
}) {
  const reduceMotion = useReducedMotion();
  const { color, Glyph, label } = INTEGRATION_META[item.type];
  const { startAngle, duration, direction } = item;
  // Each icon's own half-size eats into the available clearance budget
  // twice over (once against the visibility ceiling, once against the
  // clearance floor), so on mobile it's scaled down separately from
  // (smaller than) the position-only `spread`, to free up real room for
  // the radius clamp below. Defaults to `spread` so tablet/desktop are
  // unaffected when the caller doesn't pass it.
  const size = item.size * (sizeScale ?? spread);
  const naturalRadius = item.radius * spread;
  // minRadius/maxRadius (from HeroVisual, real DOM measurements) only
  // arrive below the sm breakpoint, where the card doesn't shrink nearly
  // as much as `spread` does, so the tuned tablet/desktop radii below
  // can no longer be trusted to clear it. Both bounds already account
  // for the card and container edges, not this icon's own half-size, so
  // it's added/subtracted here per-icon before clamping. When the two
  // bounds cross (the card's corner genuinely doesn't fit within the
  // visible container on very narrow phones), the clamp resolves to
  // maxRadius — staying fully on-screen wins over full clearance.
  const radius =
    minRadius !== undefined && maxRadius !== undefined
      ? Math.min(Math.max(naturalRadius, minRadius + size / 2), maxRadius - size / 2)
      : naturalRadius;

  if (reduceMotion) {
    const rad = (startAngle * Math.PI) / 180;
    const x = Math.cos(rad) * radius;
    const y = Math.sin(rad) * radius;
    return (
      <div
        className="absolute top-1/2 left-1/2"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        <IconBadge color={color} Glyph={Glyph} label={label} size={size} opacity={item.opacity} blur={item.blur} />
      </div>
    );
  }

  return (
    <motion.div
      className="absolute inset-0"
      style={{ willChange: "transform" }}
      animate={{ rotate: [startAngle, startAngle + 360 * direction] }}
      transition={{ duration, repeat: Infinity, ease: "linear" }}
    >
      <div
        className="absolute top-1/2 left-1/2"
        style={{ transform: `translate(-50%, -50%) translateX(${radius}px)` }}
      >
        <motion.div
          animate={{ rotate: [-startAngle, -startAngle - 360 * direction] }}
          transition={{ duration, repeat: Infinity, ease: "linear" }}
        >
          <motion.div
            animate={{ y: [0, -6, 0] }}
            transition={{
              duration: 4 + (item.radius % 5),
              repeat: Infinity,
              ease: "easeInOut",
              delay: item.startAngle / 90,
            }}
          >
            <IconBadge color={color} Glyph={Glyph} label={label} size={size} opacity={item.opacity} blur={item.blur} />
          </motion.div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function IconBadge({
  color,
  Glyph,
  label,
  size,
  opacity = 1,
  blur = 0,
}: {
  color: string;
  Glyph: (p: { style?: React.CSSProperties }) => React.JSX.Element;
  label: string;
  size: number;
  opacity?: number;
  blur?: number;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className="relative grid place-items-center rounded-2xl ring-1 ring-white/80"
      style={{
        width: size,
        height: size,
        color,
        opacity,
        filter: blur ? `blur(${blur}px)` : undefined,
        background:
          "linear-gradient(155deg, #ffffff 0%, #ffffff 55%, color-mix(in oklab, var(--color-surface-muted) 70%, white) 100%)",
        boxShadow: `0 10px 26px -10px color-mix(in oklab, ${color} 60%, transparent), 0 2px 5px -1px color-mix(in oklab, ${color} 25%, transparent), inset 0 1px 0 rgba(255,255,255,0.9)`,
      }}
    >
      <Glyph style={{ width: size * 0.52, height: size * 0.52 }} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            "radial-gradient(60% 55% at 30% 20%, rgba(255,255,255,0.65), transparent 70%)",
        }}
      />
    </span>
  );
}

export default function OrbitingIntegrations({
  items = DEFAULT_ITEMS,
  spread = 1,
  sizeScale,
  minRadius,
  maxRadius,
  className = "",
}: {
  items?: OrbitItem[];
  spread?: number;
  sizeScale?: number;
  minRadius?: number;
  maxRadius?: number;
  className?: string;
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 ${className}`}
      aria-hidden="true"
    >
      {items.map((item, i) => (
        <OrbitIcon
          key={`${item.type}-${i}`}
          item={item}
          spread={spread}
          sizeScale={sizeScale}
          minRadius={minRadius}
          maxRadius={maxRadius}
        />
      ))}
    </div>
  );
}
