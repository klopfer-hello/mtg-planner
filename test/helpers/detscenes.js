// Procedural camera scenes for the card detector tests (public/det): a
// synthetic Magic card (black border, coloured frame, title bar, art, type
// line, text box, collector line) drawn with a homography into a plain RGBA
// buffer over a scan-box-like or cloth-like background. Everything comes from
// a seeded PRNG, so the scenes are identical on every run and no image files
// (and no photos) are involved.

export const CARD_MM = [63, 88];

/** Seeded PRNG (mulberry32), returns floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= 8; k++) M[r][k] -= f * M[c][k]; }
  }
  return [...M.map((r, i) => r[8] / r[i]), 1];
}

const FRAMES = [[225, 220, 205], [70, 120, 190], [95, 90, 85], [190, 70, 55], [70, 140, 80], [205, 175, 95]];

/** A card description (colours, art blobs, text lines) for seed. */
export function makeCard(seed) {
  const r = rng(seed * 7919 + 13);
  const frame = FRAMES[Math.floor(r() * FRAMES.length)].map((v) => v * (0.9 + 0.2 * r()));
  const blobs = Array.from({ length: 7 }, () => ({
    u: 5 + r() * 53, v: 10 + r() * 38, ru: 4 + r() * 14, rv: 4 + r() * 12, c: [r() * 255, r() * 255, r() * 255],
  }));
  const sky = [[r() * 200, r() * 200, r() * 255], [r() * 120, r() * 120, r() * 120]];
  const text = Array.from({ length: 6 }, () => 0.45 + r() * 0.5);
  const title = 0.35 + r() * 0.3;
  return { frame, blobs, sky, text, title };
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Card colour at card-plane (u, v) in mm (u across, v down, upright), or null outside the rounded card. */
export function cardColor(card, u, v) {
  const [W, H] = CARD_MM, R = 3;
  if (u < 0 || v < 0 || u > W || v > H) return null;
  const cu = u < R ? R : u > W - R ? W - R : u, cv = v < R ? R : v > H - R ? H - R : v;
  if ((u - cu) ** 2 + (v - cv) ** 2 > R * R) return null;
  const black = card.black || [16, 16, 18];
  // black border (wider at the bottom, collector line inside it)
  if (u < 2.6 || u > W - 2.6 || v < 2.6) return black;
  if (v > H - 6.2) {
    if (v > H - 4.6 && v < H - 3.2 && u > 5 && u < 30 && ((u * 2.3) | 0) % 3 !== 0) return [200, 200, 200];
    return black;
  }
  const f = card.frame;
  // title bar with dark title text (left) and mana pips (right)
  if (v >= 4.2 && v <= 9.6 && u >= 4 && u <= W - 4) {
    const bar = mix(f, [245, 240, 230], 0.55);
    if (v > 5.6 && v < 8.2 && u > 6 && u < 6 + 40 * card.title && ((u * 1.6) | 0) % 4 !== 0) return [30, 28, 26];
    for (let k = 0; k < 2; k++) { const pu = W - 7.5 - k * 3.4; if ((u - pu) ** 2 + (v - 6.9) ** 2 < 1.6 ** 2) return [60, 60, 60]; }
    return bar;
  }
  // art box
  if (v >= 10.4 && v <= 48.5 && u >= 5 && u <= W - 5) {
    let c = mix(card.sky[0], card.sky[1], (v - 10.4) / 38);
    for (const b of card.blobs) {
      const d = ((u - b.u) / b.ru) ** 2 + ((v - b.v) / b.rv) ** 2;
      if (d < 1) c = mix(c, b.c, 0.85 * (1 - d * d));
    }
    return c;
  }
  // type line
  if (v >= 49.3 && v <= 54.4 && u >= 4 && u <= W - 4) {
    if (v > 50.6 && v < 53 && u > 6 && u < 34 && ((u * 1.4) | 0) % 5 !== 0) return [35, 33, 30];
    return mix(f, [245, 240, 230], 0.55);
  }
  // text box with rules text lines
  if (v >= 55.2 && v <= 79.8 && u >= 5.2 && u <= W - 5.2) {
    const line = Math.floor((v - 57) / 3.2);
    if (line >= 0 && line < card.text.length && (v - 57) % 3.2 < 1.5 && u > 7 && u < 7 + 49 * card.text[line] && ((u * 1.9) | 0) % 6 !== 0) return [40, 38, 34];
    return mix(f, [250, 246, 236], 0.8);
  }
  return f; // coloured frame
}

/** Value-noise field (smooth texture) for backgrounds. */
function valueNoise(r, gw, gh) {
  const g = Float32Array.from({ length: (gw + 1) * (gh + 1) }, () => r());
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (i, j) => g[Math.min(gh, j) * (gw + 1) + Math.min(gw, i)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}

/**
 * Background RGBA of w x h. kind 'box': dark box floor with a lighter platform rim and side walls (the card
 * sits inside it); 'cloth': a mid-tone fabric with fine texture.
 */
export function background(kind, w, h, seed) {
  const r = rng(seed * 104729 + 7);
  const d = new Uint8ClampedArray(w * h * 4);
  if (kind === 'box') {
    // a black box seen from above: dark floor/stack, lit side walls, a broad platform rim (far from card-shaped)
    const n = valueNoise(r, 12, 20), base = 10 + r() * 10, light = 0.7 + 0.5 * r();
    const wall = 0.06 * w, rim = [0.1 * w, 0.24 * h, 0.9 * w, 0.76 * h];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = base + 8 * n((x / w) * 12, (y / h) * 20) + 6 * light * (1 - Math.abs(y / h - 0.5));
      if (x < wall || x > w - wall) v += 26;
      else if (x > rim[0] && x < rim[2] && y > rim[1] && y < rim[3]) {
        const e = Math.min(x - rim[0], rim[2] - x, y - rim[1], rim[3] - y);
        if (e < 3) v += 14;
      }
      v += (r() - 0.5) * 4;
      const i = (y * w + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v + 2; d[i + 3] = 255;
    }
  } else {
    const n = valueNoise(r, 60, 100), c = [60 + r() * 120, 60 + r() * 120, 60 + r() * 120];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = 0.85 + 0.25 * n((x / w) * 60, (y / h) * 100) + (r() - 0.5) * 0.08;
      const i = (y * w + x) * 4;
      d[i] = c[0] * t; d[i + 1] = c[1] * t; d[i + 2] = c[2] * t; d[i + 3] = 255;
    }
  }
  return { w, h, d };
}

/** Draw card into img (in place) at corners (TL,TR,BR,BL, continuous px), 3x3 supersampled. */
export function drawCard(img, card, corners) {
  const { w, h, d } = img;
  const H = homography(corners, [[0, 0], [CARD_MM[0], 0], [CARD_MM[0], CARD_MM[1]], [0, CARD_MM[1]]]);
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)) + 1);
  const S = 3;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S, z = H[6] * px + H[7] * py + H[8];
      const c = cardColor(card, (H[0] * px + H[1] * py + H[2]) / z, (H[3] * px + H[4] * py + H[5]) / z);
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    if (!n) continue;
    const i = (y * w + x) * 4, a = n / (S * S);
    d[i] = d[i] * (1 - a) + (r / n) * a; d[i + 1] = d[i + 1] * (1 - a) + (g / n) * a; d[i + 2] = d[i + 2] * (1 - a) + (b / n) * a;
  }
  return img;
}

/** Add sensor-like noise and a mild blur-free brightness gain (in place). */
export function addNoise(img, seed, amp = 6, gain = 1) {
  const r = rng(seed * 31 + 3), d = img.d;
  for (let i = 0; i < d.length; i += 4) {
    const e = (r() - 0.5) * amp;
    d[i] = d[i] * gain + e; d[i + 1] = d[i + 1] * gain + e; d[i + 2] = d[i + 2] * gain + e;
  }
  return img;
}

/**
 * Card corners (TL,TR,BR,BL) for a card of short side `size` px centred at (cx, cy), rotated by `angle`
 * degrees clockwise, with a mild perspective `persp` (top side shorter by that fraction).
 */
export function placeCard(cx, cy, size, angle = 0, persp = 0) {
  const hw = size / 2, hh = size * CARD_MM[1] / CARD_MM[0] / 2, a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const local = [[-hw * (1 - persp), -hh], [hw * (1 - persp), -hh], [hw, hh], [-hw, hh]];
  return local.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/**
 * The fixed scene set: `n` box scenes (card centred and axis-aligned in a box, like a phone lying over a
 * scan box) and `n` cloth scenes (card anywhere on a table cloth, rotated, slight perspective).
 * Returns [{kind, seed, img, corners}] in a 480 x 853 work frame.
 */
export function sceneSet(n = 8, w = 480, h = 853) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rng(1000 + i), seed = 1 + i;
    const img = background('box', w, h, seed);
    const corners = placeCard(w / 2 + (r() - 0.5) * 16, h / 2 + (r() - 0.5) * 24, w * (0.6 + 0.04 * r()), (r() - 0.5) * 3, 0.01 * r());
    drawCard(img, makeCard(seed), corners);
    out.push({ kind: 'box', seed, img: addNoise(img, seed), corners });
  }
  for (let i = 0; i < n; i++) {
    const r = rng(2000 + i), seed = 101 + i;
    const img = background('cloth', w, h, seed);
    const size = w * (0.38 + 0.2 * r());
    const corners = placeCard(w * (0.35 + 0.3 * r()), h * (0.35 + 0.3 * r()), size, (r() - 0.5) * 70, 0.04 * r());
    drawCard(img, makeCard(seed), corners);
    out.push({ kind: 'cloth', seed, img: addNoise(img, seed), corners });
  }
  return out;
}

/** An empty scan box (no card). */
export function emptyBox(seed = 77, w = 480, h = 853) {
  return addNoise(background('box', w, h, seed), seed);
}

/**
 * A card on a light table with a brightness gradient and (mostly) a soft reflection on its bottom edge, in a
 * 480 x 853 work frame: at half resolution the outer edge breaks up and an inner line can win (the free-hand
 * failure of the 0.7.0-beta.4 recordings). Returns {img, corners}.
 */
export function tableScene(seed, w = 480, h = 853) {
  const r = rng(seed * 13 + 5), t = rng(seed), d = new Uint8ClampedArray(w * h * 4);
  const base = 150 + r() * 80, gx = t() - 0.5, gy = t() - 0.5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = base + 40 * (gx * x / w + gy * y / h) + (t() - 0.5) * 3, i = (y * w + x) * 4;
    d[i] = v; d[i + 1] = v - 3; d[i + 2] = v - 8; d[i + 3] = 255;
  }
  const img = { w, h, d };
  const corners = placeCard(w * (0.4 + 0.2 * r()), h * (0.4 + 0.2 * r()), w * (0.45 + 0.25 * r()), (r() - 0.5) * 30, 0.03 * r());
  drawCard(img, makeCard(seed), corners);
  if (r() < 0.7) {
    const cx = (corners[2][0] + corners[3][0]) / 2, cy = (corners[2][1] + corners[3][1]) / 2, rad = 30 + r() * 40, amt = 0.6 + 0.35 * r();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const g = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * rad * rad)) * amt, i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = d[i + k] + (255 - d[i + k]) * g;
    }
  }
  addNoise(img, seed, 8);
  return { img, corners };
}
