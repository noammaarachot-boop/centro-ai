type Blob = {
  top: string;
  side: "left" | "right";
  offset: string;
  size: string;
  color: string;
  opacity: number;
  drift: "a" | "b";
  duration: number;
};

const BLOBS: Blob[] = [
  { top: "-4%", side: "right", offset: "-8%", size: "34rem", color: "var(--color-brand-purple)", opacity: 0.32, drift: "a", duration: 26 },
  { top: "8%", side: "left", offset: "-10%", size: "30rem", color: "var(--color-brand-blue)", opacity: 0.24, drift: "b", duration: 30 },
  { top: "22%", side: "right", offset: "-6%", size: "28rem", color: "var(--color-brand-cyan)", opacity: 0.26, drift: "a", duration: 34 },
  { top: "37%", side: "left", offset: "-8%", size: "30rem", color: "var(--color-brand-pink)", opacity: 0.2, drift: "b", duration: 28 },
  { top: "52%", side: "right", offset: "-10%", size: "32rem", color: "var(--color-brand-purple)", opacity: 0.22, drift: "a", duration: 32 },
  { top: "67%", side: "left", offset: "-6%", size: "28rem", color: "var(--color-brand-cyan)", opacity: 0.22, drift: "b", duration: 30 },
  { top: "82%", side: "right", offset: "-8%", size: "30rem", color: "var(--color-brand-emerald)", opacity: 0.18, drift: "a", duration: 36 },
  { top: "96%", side: "left", offset: "-8%", size: "30rem", color: "var(--color-brand-purple)", opacity: 0.2, drift: "b", duration: 30 },
];

export default function PageBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="centro-grid absolute inset-x-0 top-0 h-[150vh]" />

      {BLOBS.map((b, i) => (
        <div
          key={i}
          className="absolute rounded-full blur-3xl"
          style={{
            top: b.top,
            [b.side]: b.offset,
            width: b.size,
            height: b.size,
            background: b.color,
            opacity: b.opacity,
            animation: `centro-drift-${b.drift} ${b.duration}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  );
}
