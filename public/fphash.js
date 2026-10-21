// fphash.js: the card fingerprint hash (pure ES module, no node: imports, no deps).
//
// Why it lives in public/: it was written to run in the browser too (the old
// client-side capture loop de-duplicated cards with it; removed in v0.5.0, see
// public/capture.js). Today its only user is lib/fingerprint.js, which imports
// this file (lib → public) and wraps the Uint32Array results in Buffers. It
// stays a browser-safe module so a future client-side use gets the same,
// bit-identical hash as the server's reference index.
//
// Layout (22 words): 0–7 gray dHash 256 (17×16) of the full card inset 3%,
// 8–15 gray dHash 256 of the art box x .12–.88 y .13–.52, 16–21 colour dHash
// 3×64 (9×8 per R, G, B). Resampling is area-average and implemented once
// here, because toolchain resampling differences alone cost 2–10 bits.

export const FP_BYTES = 88;
export const WORDS = FP_BYTES / 4;
export const BOX = Object.freeze({ full: Object.freeze([0.03, 0.03, 0.97, 0.97]), art: Object.freeze([0.12, 0.13, 0.88, 0.52]) });
export const SHIFTS = Object.freeze([-0.02, 0, 0.02]);
export const SCALES = Object.freeze([0.97, 1, 1.03]);
// Larger query inputs are area-downscaled to this size once before the variants.
export const QUERY_W = 488;
export const QUERY_H = 680;

/**
 * Area-average resample of the fractional region [x0,y0,x1,y1] of `img`
 * ({width, height, channels 1|3|4, data}) to ow×oh. Out-of-range source pixels
 * clamp to the edge. Returns Float32 RGB.
 */
export function areaResample(img, [x0, y0, x1, y1], ow, oh) {
  const { width: w, height: h, channels: ch, data: d } = img;
  const out = new Float32Array(ow * oh * 3);
  const X0 = x0 * w, Y0 = y0 * h, sx = ((x1 - x0) * w) / ow, sy = ((y1 - y0) * h) / oh;
  const g = ch === 1 ? 0 : 1, b = ch === 1 ? 0 : 2;
  for (let oy = 0; oy < oh; oy++) {
    const ya = Y0 + oy * sy, yb = ya + sy;
    for (let ox = 0; ox < ow; ox++) {
      const xa = X0 + ox * sx, xb = xa + sx;
      let r = 0, gg = 0, bb = 0, wt = 0;
      for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
        const fy = Math.min(yb, y + 1) - Math.max(ya, y);
        const yy = Math.min(h - 1, Math.max(0, y));
        for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
          const fx = Math.min(xb, x + 1) - Math.max(xa, x);
          const xx = Math.min(w - 1, Math.max(0, x));
          const f = fx * fy, i = (yy * w + xx) * ch;
          r += d[i] * f; gg += d[i + g] * f; bb += d[i + b] * f; wt += f;
        }
      }
      const o = (oy * ow + ox) * 3;
      out[o] = r / wt; out[o + 1] = gg / wt; out[o + 2] = bb / wt;
    }
  }
  return out;
}

/** Float32 RGB → Float32 luma (BT.601 weights). */
export const toGray = (p) => {
  const o = new Float32Array(p.length / 3);
  for (let i = 0; i < o.length; i++) o[i] = 0.299 * p[i * 3] + 0.587 * p[i * 3 + 1] + 0.114 * p[i * 3 + 2];
  return o;
};

/**
 * dHash: bit set when a pixel is darker than its right neighbour; (w-1)*h bits
 * written into `u` starting at bit `bit`. Returns the next free bit.
 */
export function dhashInto(u, bit, px, w, h, stride = 1, off = 0) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++, bit++) {
      if (px[(y * w + x) * stride + off] < px[(y * w + x + 1) * stride + off]) u[bit >> 5] |= 1 << (bit & 31);
    }
  }
  return bit;
}

/** Box `b` shifted by (dx, dy) and scaled by `sc` around its centre. */
export const variantBox = (b, dx, dy, sc) => {
  const cx = (b[0] + b[2]) / 2 + dx, cy = (b[1] + b[3]) / 2 + dy;
  const hw = ((b[2] - b[0]) / 2) * sc, hh = ((b[3] - b[1]) / 2) * sc;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
};

/** The 22-word fingerprint of `img` at one shift/scale variant. */
export function hashAt(img, dx = 0, dy = 0, sc = 1) {
  const u = new Uint32Array(WORDS);
  const full = variantBox(BOX.full, dx, dy, sc);
  dhashInto(u, 0, toGray(areaResample(img, full, 17, 16)), 17, 16);
  dhashInto(u, 256, toGray(areaResample(img, variantBox(BOX.art, dx, dy, sc), 17, 16)), 17, 16);
  const c = areaResample(img, full, 9, 8);
  let bit = 512;
  for (let ch = 0; ch < 3; ch++) bit = dhashInto(u, bit, c, 9, 8, 3, ch);
  return u;
}

/**
 * Query-side hashes of a (rectified) card image: 27 variants (shift x, shift
 * y, scale; ±2% shift, scale .97/1/1.03) by default, or `variants: 9` for the
 * 3×3 shift grid at scale 1 (cheaper, for the browser). Inputs larger than
 * 1.25× QUERY_W×QUERY_H are area-downscaled to it first.
 * @returns {Uint32Array[]}
 */
export function hashQuery(pixels, { variants = 27 } = {}) {
  if (variants !== 27 && variants !== 9) throw new Error(`hashQuery: variants must be 27 or 9, got ${variants}`);
  let img = pixels;
  if (img.width > QUERY_W * 1.25 || img.height > QUERY_H * 1.25) {
    const rgb = areaResample(img, [0, 0, 1, 1], QUERY_W, QUERY_H);
    img = { width: QUERY_W, height: QUERY_H, channels: 3, data: rgb };
  }
  const scales = variants === 9 ? [1] : SCALES;
  const out = [];
  for (const dx of SHIFTS) for (const dy of SHIFTS) for (const sc of scales) out.push(hashAt(img, dx, dy, sc));
  return out;
}

/** 32-bit popcount (SWAR). */
export const pc = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

/** A hash as 22 words: Uint32Array as is, any byte array (Buffer, Uint8Array) copied. */
export const asWords = (h) => (h instanceof Uint32Array ? h : new Uint32Array(Uint8Array.from(h).buffer));

// Integer distance 3·full + 3·art + 4·colour; divide by 2304 for the 0..1 score.
export const SCALE = 2304;

/** Normalised combined distance (0 = identical, ~0.5 = unrelated). */
export function score(a, b) {
  const A = asWords(a), B = asWords(b);
  let f = 0, r = 0, c = 0;
  for (let k = 0; k < 8; k++) f += pc((A[k] ^ B[k]) >>> 0);
  for (let k = 8; k < 16; k++) r += pc((A[k] ^ B[k]) >>> 0);
  for (let k = 16; k < 22; k++) c += pc((A[k] ^ B[k]) >>> 0);
  return (3 * f + 3 * r + 4 * c) / SCALE;
}
