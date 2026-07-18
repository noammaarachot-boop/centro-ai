"use client";

import { MotionConfig } from "framer-motion";
import { useAccessibility } from "./AccessibilityProvider";

export default function MotionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { prefs } = useAccessibility();

  return (
    <MotionConfig reducedMotion={prefs.reducedMotion ? "always" : "user"}>
      {children}
    </MotionConfig>
  );
}
