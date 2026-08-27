/**
 * Generates every Centro logo asset from the ONE official source image.
 *
 * Run: node scripts/buildBrandAssets.mjs [path-to-source]
 *
 * The source is a square photo-style render: the mark sits on a white
 * "coin" with a soft halo and a lot of empty canvas. Shipping that as a
 * favicon would show a mostly-white square, so this crops to the mark's own
 * bounding box and lifts it off the background.
 *
 * The background is removed by flood-filling inward from the border across
 * near-neutral pixels, NOT by un-matting against white. Un-matting derives
 * alpha from a pixel's darkest channel, which would make solid brand purple
 * (#8B5CF6, darkest channel 0x5C) come out ~64% transparent. Flood-filling
 * leaves every kept pixel's colour exactly as the designer produced it —
 * which is the requirement: the artwork is reproduced, never redrawn.
 *
 * The C's inner counter is intentionally cleared too: the letter is open on
 * its right side, so the counter is reachable from the border and is part of
 * the same background region.
 */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";

const SRC = process.argv[2] ?? "assets/brand/centro-logo-source.jpg";
const OUT = "public/brand";

/**
 * Bright and near-neutral: the coin, its shadow, and the page behind it.
 *
 * Judged on ABSOLUTE chroma (max-min), not the saturation ratio. The coin's
 * rim carries a pale blue glow whose ratio reads ~0.4 — high enough to look
 * like brand colour — while its actual chroma is ~35. The mark's own pixels
 * run 150+. Using the ratio left that rim behind as a ghost arc in the
 * bottom-right of the icon; chroma separates them cleanly.
 */
function isBackground(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx > 150 && mx - mn < 100;
}

async function main() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x, y) => (y * width + x) * channels;

  // ── 1. Flood fill the background from every border pixel. ──────────
  const bg = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const k = y * width + x;
    if (bg[k]) return;
    const i = at(x, y);
    if (!isBackground(data[i], data[i + 1], data[i + 2])) return;
    bg[k] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  // ── 2. Alpha = "not background", then crop to what survives. ───────
  const rgba = Buffer.alloc(width * height * 4);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x, i = at(x, y), o = k * 4;
      rgba[o] = data[i]; rgba[o + 1] = data[i + 1]; rgba[o + 2] = data[i + 2];
      rgba[o + 3] = bg[k] ? 0 : 255;
      if (!bg[k]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  console.log(`mark bounds ${w}x${h} (aspect ${(w / h).toFixed(4)}) from ${width}x${height}`);

  const cropped = sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: w, height: h });

  await fs.mkdir(OUT, { recursive: true });

  // ── 3. The mark itself, at its own aspect ratio. ───────────────────
  // 512 is ~6x the largest size the mark is ever rendered at (78px), so it
  // stays sharp on any display while a palette PNG keeps it at ~34KB rather
  // than the ~360KB a 1024px truecolour version costs on every page load.
  const MARK_W = 512;
  await cropped
    .clone()
    .resize({ width: MARK_W, kernel: "lanczos3" })
    // Lanczos downscaling from the 735px original anti-aliases the edge, so
    // no separate alpha feathering pass is needed. Palette quantisation is
    // visually clean here — checked against the truecolour render for
    // banding across the purple-to-cyan gradient.
    .png({ palette: true, quality: 90, compressionLevel: 9 })
    .toFile(path.join(OUT, "centro-logo.png"));
  console.log("wrote", path.join(OUT, "centro-logo.png"));

  // ── 4. Square icon: the mark centred on transparency, filling the
  //       tile rather than floating in the source's empty canvas. ─────
  const ICON = 512;
  const pad = Math.round(ICON * 0.06);
  const inner = ICON - pad * 2;
  const scale = Math.min(inner / w, inner / h);
  const iw = Math.round(w * scale), ih = Math.round(h * scale);
  const square = await cropped.clone().resize({ width: iw, height: ih, kernel: "lanczos3" }).png().toBuffer();
  await sharp({
    create: { width: ICON, height: ICON, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: square, left: Math.round((ICON - iw) / 2), top: Math.round((ICON - ih) / 2) }])
    .png({ palette: true, quality: 90, compressionLevel: 9 })
    .toFile(path.join(OUT, "centro-icon.png"));
  console.log(`wrote ${path.join(OUT, "centro-icon.png")} (${iw}x${ih} inside ${ICON})`);

  // Next.js file-convention icons. Static files, so they stay pixel-exact
  // instead of being re-rendered by satori at request time.
  for (const [file, size] of [["src/app/icon.png", 96], ["src/app/apple-icon.png", 180]]) {
    await sharp(path.join(OUT, "centro-icon.png")).resize(size, size, { kernel: "lanczos3" }).png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(file);
    console.log("wrote", file, `(${size}px)`);
  }
}

await main();
