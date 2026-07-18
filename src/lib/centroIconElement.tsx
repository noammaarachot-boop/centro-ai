/**
 * Shared crescent-"C" tile used by app/icon.tsx and app/apple-icon.tsx.
 * Built from plain flex/border-radius shapes (no external assets) so it
 * renders sharp via ImageResponse/satori at any requested size.
 */
export function centroIconElement(size: number) {
  const innerR = size * 0.375;
  const innerOffset = size * 0.22;

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        position: "relative",
        borderRadius: size * 0.28,
        background: "linear-gradient(135deg, #8B5CF6 0%, #3B6DFF 55%, #17C3D6 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: innerR * 2,
          height: innerR * 2,
          left: size * 0.5 + innerOffset - innerR,
          top: size * 0.5 - innerR,
          borderRadius: innerR * 2,
          background: "#FBFAFF",
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: size * 0.16,
          height: size * 0.16,
          left: size * 0.78,
          top: size * 0.2,
          borderRadius: size * 0.16,
          background: "#FBCFE8",
          display: "flex",
        }}
      />
    </div>
  );
}
