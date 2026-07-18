"use client";

import { useId } from "react";

/**
 * Centro's brand mark: an open ring (evoking both the letter C and an
 * orbit path) with a small accent particle at the opening — ties
 * directly to the orbiting-integrations motif used across the product.
 * Kept to a single stroke + one dot so it stays legible down to
 * favicon scale.
 */
export function CentroMark({
  className = "",
  title,
}: {
  className?: string;
  title?: string;
}) {
  const uid = useId();
  const gradId = `centro-ring-${uid}`;
  const glowId = `centro-glow-${uid}`;

  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={gradId} x1="7" y1="6" x2="33" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8B5CF6" />
          <stop offset="52%" stopColor="#3B6DFF" />
          <stop offset="100%" stopColor="#17C3D6" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#F472B6" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#F472B6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <path
        d="M28.36 29.96A13 13 0 1 1 28.36 10.04"
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth="5.4"
        strokeLinecap="round"
      />

      <circle cx="30.3" cy="7.7" r="5.2" fill={`url(#${glowId})`} />
      <circle cx="30.3" cy="7.7" r="2.3" fill="#FBCFE8" />
      <circle cx="30.3" cy="7.7" r="1.4" fill="#ffffff" />
    </svg>
  );
}
