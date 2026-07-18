import type { Transition, Variants } from "framer-motion";

export const EASE_STANDARD: Transition["ease"] = [0.22, 1, 0.36, 1];
export const EASE_SOFT: Transition["ease"] = [0.16, 1, 0.3, 1];

export const DURATION = {
  fast: 0.15,
  medium: 0.4,
  slow: 0.8,
} as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.slow, ease: EASE_STANDARD },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: DURATION.slow, ease: EASE_STANDARD },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: DURATION.slow, ease: EASE_STANDARD },
  },
};

export function staggerContainer(
  stagger = 0.12,
  delayChildren = 0
): Variants {
  return {
    hidden: {},
    show: {
      transition: {
        staggerChildren: stagger,
        delayChildren,
      },
    },
  };
}

export const viewportOnce = { once: true, margin: "-80px 0px -80px 0px" };
