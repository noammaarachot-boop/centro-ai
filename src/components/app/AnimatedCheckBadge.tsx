// A circle draws in, then transforms into a checkmark, with a brief glow
// pulse — replaces a static CheckCircle2 icon wherever a "just confirmed"
// moment deserves it (connection rows, setup-summary rows). Re-mount with
// a new `key` to replay it (see .centro-check-* in globals.css).
// `delayMs` staggers a badge within a list of rows (via the --check-delay
// custom property the CSS reads); omit it for an independent badge.
export function AnimatedCheckBadge({
  size = 30,
  delayMs,
  className,
}: {
  size?: number;
  delayMs?: number;
  className?: string;
}) {
  return (
    <span
      className={`centro-check-badge${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        ...(delayMs !== undefined ? { "--check-delay": `${delayMs}ms` } : {}),
      } as React.CSSProperties}
    >
      <span className="centro-check-glow" aria-hidden="true" />
      <svg viewBox="0 0 36 36" width={size} height={size} role="img" aria-label="הושלם">
        <circle className="centro-check-circle" cx="18" cy="18" r="15.9" />
        <path className="centro-check-mark" d="M11 18.5l4.5 4.5L25.5 12" />
      </svg>
    </span>
  );
}
