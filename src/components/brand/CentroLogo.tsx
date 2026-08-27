/**
 * THE Centro logo. Every brand mark in the product renders through here.
 *
 * There used to be two unrelated drawings of it: an inline SVG (an open
 * gradient ring with a pink accent dot) used across the app and landing
 * page, and a separate flex/border-radius tile used only for the favicon
 * and Apple touch icon. Neither matched the official artwork, and they did
 * not match each other — the tab icon was a different logo from the sidebar.
 *
 * Both are gone. The asset here is generated from the official source image
 * by scripts/buildBrandAssets.mjs, which crops the mark out of the source's
 * white coin and lifts it onto transparency without altering a pixel of the
 * artwork itself. To change the logo, replace the source image and re-run
 * that script — never hand-edit an asset, and never add a second drawing.
 *
 * Sizing is the ONLY thing a caller may vary. `object-contain` inside the
 * caller's box preserves the mark's 512:433 aspect ratio at every size, so a
 * square slot letterboxes rather than stretching it.
 */

/**
 * Intrinsic size of public/brand/centro-logo.png, for aspect + no layout
 * shift. Must match what scripts/buildBrandAssets.mjs emits.
 */
export const CENTRO_LOGO_ASPECT = { width: 512, height: 433 } as const;

export function CentroLogo({
  className = "",
  title,
}: {
  className?: string;
  /** Provide for a standalone mark; omit when adjacent text already says "Centro". */
  title?: string;
}) {
  return (
    /* A plain <img>, not next/image: this is a fixed, few-KB mark served
       from /public and rendered at 16-80px. The optimizer would add a
       request and a cache entry per size for no gain. */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/centro-logo.png"
      width={CENTRO_LOGO_ASPECT.width}
      height={CENTRO_LOGO_ASPECT.height}
      alt={title ?? ""}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      decoding="async"
      className={`object-contain ${className}`}
    />
  );
}
