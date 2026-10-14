// Procedural capture scenes for the CaptureController tests (public/capture.js).
//
// A scene is a background plus a stack of synthetic cards (test/helpers/
// detscenes.js draws the same cards) and an optional hand blob, evaluated
// analytically per pixel, so a frame never has to be rendered in full: the
// rig samples only what the analyzer would hand the controller (24x40 frame
// thumbnail, 12x16 card-region thumbnail, the rectified hash crop). The rig
// also stands in for detect() + QuadTracker: a card that lies still for a few
// frames becomes `stable`, a moving one is tracked but unstable, a covered or
// undetectable one is lost or weak. Everything is seeded; no images, no photos.

import { makeCard as baseCard, cardColor, placeCard, rng, CARD_MM } from './detscenes.js';

export { placeCard, rng };

/** A synthetic card for seed (detscenes.makeCard plus its own print texture). */
export const makeCard = (seed) => ({ ...baseCard(seed), texSeed: seed * 13 + 7 });

/** Projective map of the unit square → quad corners [TL,TR,BR,BL]; returns (u,v) → [x,y]. */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return { a, b, c: x0, d, e, f: y0, g, h };
}

/** Inverse of squareToQuad: frame (x,y) → unit-square (u,v). */
function quadToSquare(q) {
  const { a, b, c, d, e, f, g, h } = squareToQuad(q);
  // adjugate of [[a,b,c],[d,e,f],[g,h,1]]
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  return (x, y) => { const z = G * x + H * y + I; return [(A * x + B * y + C) / z, (D * x + E * y + F) / z]; };
}

const mapQuad = (q) => { const m = squareToQuad(q); return (u, v) => { const z = m.g * u + m.h * v + 1; return [(m.a * u + m.b * v + m.c) / z, (m.d * u + m.e * v + m.f) / z]; }; };
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** Smooth seeded value noise in [0,1). */
function valueNoise(seed, gw, gh) {
  const r = rng(seed), g = Float32Array.from({ length: (gw + 1) * (gh + 1) }, () => r());
  return (x, y) => {
    x = Math.max(0, Math.min(gw - 1e-6, x)); y = Math.max(0, Math.min(gh - 1e-6, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (i, j) => g[j * (gw + 1) + i];
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
}

/**
 * A scene: `kind` 'box' (dark scan-box floor with lit walls) or 'table' (mid-tone cloth), frame w x h.
 * Mutable: cards[] (bottom → top: {id, card, quad, look, detect}), hand, light.
 */
export class Scene {
  constructor(kind = 'box', seed = 1, w = 480, h = 853) {
    Object.assign(this, { kind, seed, w, h, cards: [], hand: null, light: 1 });
    this.noise = valueNoise(seed * 977 + 5, 12, 20);
    this.tint = kind === 'box' ? [16, 16, 18] : [70 + (seed * 37) % 90, 80 + (seed * 53) % 70, 60 + (seed * 71) % 80];
  }

  /** Background colour at (x, y). */
  bg(x, y) {
    const n = this.noise((x / this.w) * 12, (y / this.h) * 20);
    if (this.kind === 'box') {
      const wall = x < 0.06 * this.w || x > 0.94 * this.w ? 26 : 0;
      const v = 12 + 10 * n + wall;
      return [v, v, v + 2];
    }
    const t = 0.8 + 0.35 * n;
    return [this.tint[0] * t, this.tint[1] * t, this.tint[2] * t];
  }

  /** Scene colour at frame point (x, y): hand over cards (top first) over the background. */
  colorAt(x, y) {
    const hd = this.hand;
    if (hd && ((x - hd.cx) / hd.rx) ** 2 + ((y - hd.cy) / hd.ry) ** 2 < 1) return hd.color;
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const c = this.cards[i];
      c.inv ||= quadToSquare(c.quad);
      const [u, v] = c.inv(x, y);
      let col = this.printed(c.card, u, v);
      if (!col) continue;
      if (c.morph) {
        // the card's content cross-fading into another card (the slow-drift case)
        const m = this.printed(c.morph.card, u, v), t = c.morph.t;
        if (m) col = [col[0] + (m[0] - col[0]) * t, col[1] + (m[1] - col[1]) * t, col[2] + (m[2] - col[2]) * t];
      }
      const L = c.look || {}, g = (L.gain ?? 1) * this.light, o = L.bias ?? 0;
      let out = [col[0] * g + o, col[1] * g + o, col[2] * g + o];
      if (L.glare) {
        // a soft specular patch in card-relative coordinates
        const { gu, gv, gr, ga } = L.glare, dd = ((u - gu) ** 2 + (v - gv) ** 2) / (gr * gr);
        if (dd < 1) { const k = ga * (1 - dd); out = out.map((ch) => ch + (255 - ch) * k); }
      }
      return out;
    }
    const b = this.bg(x, y);
    return [b[0] * this.light, b[1] * this.light, b[2] * this.light];
  }

  /**
   * Printed colour of `card` at unit-square (u, v), with a smooth per-card print texture so flat areas
   * still have a stable gradient (real cards are never perfectly flat; on flat synthetic areas the dHash
   * bits would be pure noise).
   */
  printed(card, u, v) {
    const col = cardColor(card, u * CARD_MM[0], v * CARD_MM[1]);
    if (!col) return null;
    card.tex ||= valueNoise(card.texSeed ?? 31, 9, 12);
    const t = 70 * (card.tex(u * 9, v * 12) - 0.5);
    return [col[0] + t, col[1] + t, col[2] + t];
  }

  /** The top card (or null). */
  top() { return this.cards[this.cards.length - 1] || null; }

  /** Push a card on top. */
  add(id, card, quad, { look = null, detect = 'ok' } = {}) {
    const c = { id, card, quad, look, detect };
    this.cards.push(c);
    return c;
  }

  /** Move a card (invalidates its inverse map). */
  move(c, quad) { c.quad = quad; c.inv = null; }
}

/** 24x40 luma thumbnail of the frame (point samples, like track.mjs frameThumb) plus sensor noise. */
export function frameThumb(scene, r, amp = 1.5, TW = 24, TH = 40) {
  const t = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    t[y * TW + x] = luma(scene.colorAt((x + 0.5) * scene.w / TW, (y + 0.5) * scene.h / TH)) + (r() - 0.5) * amp;
  }
  return t;
}

/** 12x16 luma thumbnail of the quad's region (each cell averaged over 4x4 samples, like a downscale). */
export function cardThumb(scene, quad, r, amp = 1.5, TW = 12, TH = 16) {
  const m = mapQuad(quad), t = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    let s = 0;
    for (let k = 0; k < 16; k++) {
      const [px, py] = m((x + ((k & 3) + 0.5) / 4) / TW, (y + ((k >> 2) + 0.5) / 4) / TH);
      s += luma(scene.colorAt(px, py));
    }
    t[y * TW + x] = s / 16 + (r() - 0.5) * amp;
  }
  return t;
}

// 2x2 sample footprint spanning 1.2 crop px: a mild optical blur (camera crops are never razor sharp,
// and hard synthetic edges would make the hash flip bits on sub-pixel jitter)
const BL = [-0.6, 0.6].flatMap((dy) => [-0.6, 0.6].map((dx) => [dx, dy]));

/**
 * Rectified RGB crop of `quad` (the hash source), W x H, with sensor noise, as
 * fphash expects ({width, height, channels: 3, data}). 2x2 supersampled.
 */
export function hashCrop(scene, quad, r, { W = 244, H = 340, amp = 2 } = {}) {
  const m = mapQuad(quad), data = new Uint8ClampedArray(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let R = 0, G = 0, B = 0;
    for (let s = 0; s < BL.length; s++) {
      const [px, py] = m((x + 0.5 + BL[s][0]) / W, (y + 0.5 + BL[s][1]) / H);
      const c = scene.colorAt(px, py);
      R += c[0]; G += c[1]; B += c[2];
    }
    const e = (r() - 0.5) * amp, i = (y * W + x) * 3;
    data[i] = R / BL.length + e; data[i + 1] = G / BL.length + e; data[i + 2] = B / BL.length + e;
  }
  return { width: W, height: H, channels: 3, data };
}

const jitterQuad = (q, r, px) => q.map(([x, y]) => [x + (r() - 0.5) * 2 * px, y + (r() - 0.5) * 2 * px]);
const sameQuad = (a, b) => a && b && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);

/**
 * Stand-in for the analyzer (detect + QuadTracker + thumbnails). frame() returns
 * the per-frame analysis object the controller consumes; o.scene/o.seed let the
 * crop callback (rig.crop) render the hash crop for any quad at that moment.
 */
export class Rig {
  constructor(scene, { fps = 8, seed = 7, stableFrames = 4, jitter = 0.2 } = {}) {
    Object.assign(this, { scene, fps, stableFrames, jitter });
    this.r = rng(seed);
    this.t = 1000;
    this.n = 0;
    this.lastQuad = null;
    this.still = 0;
    this.cropSeed = seed * 7 + 1;
  }

  /** One analysed frame of the current scene. extra: fields merged in (busy, paused, priorQuad, sharp). */
  frame(extra = {}) {
    const s = this.scene, top = s.top(), r = this.r;
    this.t += 1000 / this.fps;
    this.n++;
    // the hand hides the card from the detector when it covers the card centre
    let visible = top && top.detect !== 'none';
    if (visible && s.hand) {
      const q = top.quad, cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
      if (((cx - s.hand.cx) / (s.hand.rx + 40)) ** 2 + ((cy - s.hand.cy) / (s.hand.ry + 40)) ** 2 < 1) visible = false;
    }
    const moved = !visible || !sameQuad(this.lastQuad, top.quad);
    this.still = moved ? (visible ? 1 : 0) : this.still + 1;
    this.lastQuad = visible ? top.quad.map((p) => [...p]) : null;
    const o = {
      now: this.t, vw: s.w, vh: s.h,
      found: Boolean(visible), weak: Boolean(visible && top.detect === 'weak'), accepted: Boolean(visible && top.detect === 'ok'),
      stable: Boolean(visible && this.still >= this.stableFrames),
      corners: visible ? jitterQuad(top.quad, r, this.jitter) : null,
      thumb: frameThumb(s, r),
      sharp: visible ? (this.still >= 2 ? 120 + r() * 10 : 30) : 0,
      scene: s, seed: this.cropSeed + this.n,
      ...extra,
    };
    o.cardThumb = o.corners ? cardThumb(s, o.corners, r) : null;
    return o;
  }

  /** Crop callback for CaptureController({crop}). */
  crop = (o, quad) => (o.scene && quad ? hashCrop(o.scene, quad, rng(o.seed), this.cropOpts) : null);
}

/** Card quad for the scan box: centred, axis-aligned, 62% of the frame width, small offset (dx, dy px). */
export function boxQuad(scene, dx = 0, dy = 0, angle = 0) {
  return placeCard(scene.w / 2 + dx, scene.h / 2 + dy, scene.w * 0.62, angle);
}

/** Linear interpolation between two quads. */
export const lerpQuad = (a, b, t) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
