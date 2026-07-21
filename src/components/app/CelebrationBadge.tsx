import { Sparkles } from "lucide-react";

// A restrained, premium "celebration" moment for onboarding completion —
// per the approved design review: "real premium celebrations, luxurious
// not childish/gamey." A handful of soft blurred light particles drift
// outward and fade once on mount (see .centro-celebrate-particle in
// globals.css), framing a glowing AI-gradient badge — no emoji, no
// confetti library, no looping animation once the moment settles.
const PARTICLES: Array<{ color: string; size: number; x: string; y: string; delay: string }> = [
  { color: "var(--color-brand-purple)", size: 10, x: "-46px", y: "-52px", delay: "0s" },
  { color: "var(--color-brand-blue)", size: 8, x: "42px", y: "-58px", delay: "0.1s" },
  { color: "var(--color-brand-cyan)", size: 9, x: "-56px", y: "12px", delay: "0.2s" },
  { color: "#F472B6", size: 6, x: "52px", y: "4px", delay: "0.3s" },
  { color: "var(--color-brand-purple)", size: 7, x: "2px", y: "-72px", delay: "0.4s" },
  { color: "var(--color-brand-emerald)", size: 6, x: "-18px", y: "50px", delay: "0.5s" },
];

export function CelebrationBadge() {
  return (
    <div className="centro-celebrate mx-auto mb-4 h-20 w-20">
      {PARTICLES.map((particle, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="centro-celebrate-particle"
          style={
            {
              width: particle.size,
              height: particle.size,
              background: particle.color,
              animationDelay: particle.delay,
              "--particle-x": particle.x,
              "--particle-y": particle.y,
            } as React.CSSProperties
          }
        />
      ))}
      <span className="centro-ai-gradient grid h-20 w-20 place-items-center rounded-full text-white shadow-[0_18px_40px_-14px_rgba(124,58,237,0.45)]">
        <Sparkles className="h-8 w-8" aria-hidden="true" />
      </span>
    </div>
  );
}
