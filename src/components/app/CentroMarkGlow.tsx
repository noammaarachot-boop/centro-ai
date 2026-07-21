import { CentroMark } from "@/components/landing/icons/CentroMark";

// Wraps the official CentroMark with an optional soft glow halo and/or
// gentle breathing scale, per the brand rule: the mark itself (imported,
// never redrawn) is untouched — only this wrapper's presentation varies.
export function CentroMarkGlow({
  size = 30,
  breathe = false,
  glow = false,
}: {
  size?: number;
  breathe?: boolean;
  glow?: boolean;
}) {
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      {glow && (
        <span
          aria-hidden="true"
          className="centro-mark-halo absolute rounded-full"
          style={{ width: size * 2, height: size * 2 }}
        />
      )}
      <span
        className={breathe ? "centro-mark-breathe relative z-[1]" : "relative z-[1]"}
        style={{ width: size, height: size }}
      >
        <CentroMark className="h-full w-full" title="Centro" />
      </span>
    </span>
  );
}
