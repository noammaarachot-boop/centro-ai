"use client";

import { useLayoutEffect, useState } from "react";

const MQ_LG = "(min-width: 1024px)";
const MQ_SM = "(min-width: 640px)";

/**
 * Returns a plain numeric multiplier for the current breakpoint.
 *
 * Used instead of a CSS `transform: scale()` wrapper: scaling a DOM
 * subtree visually shrinks already-rasterized text/icons and reads as
 * blurry. This drives real pixel values (radius, offset, size) so
 * everything renders crisp at its true size.
 */
export function useResponsiveScale(
  mobile: number,
  tablet: number,
  desktop: number
) {
  const [scale, setScale] = useState(desktop);

  useLayoutEffect(() => {
    const mqLg = window.matchMedia(MQ_LG);
    const mqSm = window.matchMedia(MQ_SM);
    const update = () => {
      setScale(mqLg.matches ? desktop : mqSm.matches ? tablet : mobile);
    };
    update();
    mqLg.addEventListener("change", update);
    mqSm.addEventListener("change", update);
    return () => {
      mqLg.removeEventListener("change", update);
      mqSm.removeEventListener("change", update);
    };
  }, [mobile, tablet, desktop]);

  return scale;
}
