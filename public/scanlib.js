// scanlib.js: browser-side card capture for the scanner (ES module, no deps).
//
// Why it exists: the server identifies cards from a rectified photo plus a
// sharp crop of the collector line, so the phone must find the card, wait for a
// steady and sharp frame, straighten it and cut out the bottom strip. All pixel
// work is plain typed-array JS (no opencv.js, CSP stays as is), so everything
// except the camera/canvas helpers at the bottom also runs in node for tests.
//
// Images: gray = {w, h, d: Float32Array}; RGBA = {w, h, d: Uint8ClampedArray}.
// Corners are always [TL, TR, BR, BL] as [x, y] in the image's pixel space.
//
// Two detector paths (v0.5.x): 'v2' (default) = detector A2 (det/detect.mjs)
// anywhere in the frame + QuadTracker + a per-device learned box prior
// (createDetAnalyzer, feeding capture.js ProbeController); 'v1' = the old
// guide-frame finder (findCard, createAnalyzer, AutoCapture), kept unchanged as
// the rollback (?det=v1 or localStorage mtg.scan.det = "v1", scanDetVersion()).
// Also here: the scan sounds (Web Audio, synthesized, no files).

import { detect, refine } from './det/detect.mjs';
import { QuadTracker, BoxPrior, PRIOR_STORAGE_KEY, frameThumb, align } from './det/track.mjs';
import { areaResample } from './fphash.js';

/** Capture tuning. Values come from the synthetic-capture research; the UI may override. */
export const CAPTURE_DEFAULTS = Object.freeze({
  guideFrac: 0.65,        // guide card width as a fraction of the frame's short side
  workWidth: 360,         // analysis canvas width (findCard)
  fps: 8,                 // analysis rate
  stableMad: 2.0,         // 64x64 thumbnail mean abs diff between analysed frames
  stableFrames: 4,        // ... for this many consecutive frames
  cornerDrift: 0.015,     // corners move less than this fraction of the guide width
  sharpRel: 0.85,         // strip sharpness >= this x max over the window
  sharpWindowMs: 1500,
  sharpFloor: 60,         // absolute Laplacian-variance floor (strip at <= 640 px wide)
  leaveFrames: 8,         // no card (not even a weak quad) for this many frames (~1 s) ...
  leaveMad: 10,           // ... and the scene differs this much from the captured frame = card left, re-arm
  rearmMad: 15,           // or the scene changed this much against the captured frame
  sameCardBits: 10,       // ... unless the art dHash says it is still the same card
  cardSize: [1000, 1400], // rectified card upload
  cardQuality: 0.85,
  stripQuality: 0.92,
  // Bottom strip in card fractions, padded because on dark mats the inner
  // black border can be detected instead of the outer edge.
  stripRegion: Object.freeze({ x0: -0.03, y0: 0.85, x1: 1.03, y1: 1.04 }),
  stripMaxWidth: 2400,
  workShort: 480,         // v2: analysis canvas short side (detector A2 was tuned at 480)
  photoLongSide: 1440,    // v2: takePhoto re-detect runs on a copy this long (long side)
});

const CARD_ASPECT = 63 / 88;

// ---------------------------------------------------------------------------
// Basic image ops

export function toGray(img) {
  const { w, h, d } = img, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { w, h, d: g };
}

/** Area-average resample of a gray image (any ratio; upsampling repeats pixels). */
export function resizeGray(src, W, H) {
  if (W === src.w && H === src.h) return { w: W, h: H, d: Float32Array.from(src.d) };
  const out = new Float32Array(W * H), sx = src.w / W, sy = src.h / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.min(src.h - 1, Math.floor(y * sy)), y1 = Math.min(src.h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.min(src.w - 1, Math.floor(x * sx)), x1 = Math.min(src.w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) { const r = yy * src.w; for (let xx = x0; xx < x1; xx++) s += src.d[r + xx]; }
      out[y * W + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return { w: W, h: H, d: out };
}

export function cropGray(g, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(g.w - x, Math.round(w)); h = Math.min(g.h - y, Math.round(h));
  const d = new Float32Array(w * h);
  for (let r = 0; r < h; r++) d.set(g.d.subarray((y + r) * g.w + x, (y + r) * g.w + x + w), r * w);
  return { w, h, d };
}

// 3x3 box blur that keeps the border pixels (zeros there would fake an edge).
function boxBlur3(g) {
  const { w, h, d } = g, o = Float32Array.from(d);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = (d[i - w - 1] + d[i - w] + d[i - w + 1] + d[i - 1] + d[i] + d[i + 1] + d[i + w - 1] + d[i + w] + d[i + w + 1]) / 9;
  }
  return { w, h, d: o };
}

// ---------------------------------------------------------------------------
// Quality metrics and a tiny hash

/** Variance of the 4-neighbour Laplacian (sharpness; higher = sharper). */
export function laplacianVariance(g) {
  const { w, h, d } = g;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = d[i - 1] + d[i + 1] + d[i - w] + d[i + w] - 4 * d[i];
    s += l; s2 += l * l; n++;
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/** Mean absolute difference of two equally sized gray images (0..255). */
export function meanAbsDiff(a, b) {
  if (!a || !b || a.d.length !== b.d.length) return 255;
  let s = 0;
  for (let i = 0; i < a.d.length; i++) s += Math.abs(a.d[i] - b.d[i]);
  return s / a.d.length;
}

/** Difference hash: size*size bits as a Uint8Array of 0/1. */
export function dHash(g, size = 8) {
  const r = resizeGray(g, size + 1, size), bits = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    bits[y * size + x] = r.d[y * (size + 1) + x] < r.d[y * (size + 1) + x + 1] ? 1 : 0;
  }
  return bits;
}

export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] !== b[i];
  return n;
}

/** 64x64 gray thumbnail used for frame-to-frame stability. */
export const thumb64 = (gray) => resizeGray(gray, 64, 64);

// ---------------------------------------------------------------------------
// Homography and warping

function solve8(A, b) {
  const n = 8, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Homography mapping src[i] -> dst[i] for 4 point pairs. Returns a 9-array (or null if degenerate). */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve8(A, b);
  return h ? [...h, 1] : null;
}

export function applyH(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
}

/**
 * Rectify the quad `corners` (TL,TR,BR,BL) of RGBA `img` into an outW x outH
 * RGBA image with bilinear sampling. Pixels outside the source are clamped.
 */
export function warpQuad(img, corners, outW, outH) {
  const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], corners);
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (!H) return { w: outW, h: outH, d: out };
  const { w, h, d } = img;
  for (let y = 0; y < outH; y++) {
    const yc = y + 0.5;
    // numerators and denominator are linear in x: step them incrementally
    let nx = H[0] * 0.5 + H[1] * yc + H[2], ny = H[3] * 0.5 + H[4] * yc + H[5], nz = H[6] * 0.5 + H[7] * yc + H[8];
    let o = y * outW * 4;
    for (let x = 0; x < outW; x++, o += 4, nx += H[0], ny += H[3], nz += H[6]) {
      const sx = nx / nz - 0.5, sy = ny / nz - 0.5;
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(h - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
      out[o] = d[i00] * a + d[i10] * b + d[i01] * c + d[i11] * e;
      out[o + 1] = d[i00 + 1] * a + d[i10 + 1] * b + d[i01 + 1] * c + d[i11 + 1] * e;
      out[o + 2] = d[i00 + 2] * a + d[i10 + 2] * b + d[i01 + 2] * c + d[i11 + 2] * e;
      out[o + 3] = 255;
    }
  }
  return { w: outW, h: outH, d: out };
}

/** Sub-quad of a card quad for a region given in card fractions {x0,y0,x1,y1}. */
export function regionQuad(corners, { x0, y0, x1, y1 }) {
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], corners);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => applyH(H, x, y));
}

export function quadBounds(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Mean of the two horizontal (w) and two vertical (h) side lengths. */
export function quadSize(q) {
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: (len(q[0], q[1]) + len(q[3], q[2])) / 2, h: (len(q[0], q[3]) + len(q[1], q[2])) / 2 };
}

/** Largest corner displacement between two quads, in pixels. */
export function cornerDrift(a, b) {
  if (!a || !b) return Infinity;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

export const scaleQuad = (q, sx, sy = sx, dx = 0, dy = 0) => q.map(([x, y]) => [x * sx + dx, y * sy + dy]);

// ---------------------------------------------------------------------------
// Guide frame and card localisation

/** Guide rectangle (MTG 63x88) centred in a vw x vh frame, `frac` of the short side wide. */
export function guideRect(vw, vh, frac = CAPTURE_DEFAULTS.guideFrac) {
  let w = frac * Math.min(vw, vh), h = w / CARD_ASPECT;
  if (h > 0.92 * vh) { h = 0.92 * vh; w = h * CARD_ASPECT; }
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

export const rectQuad = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

/**
 * Find the card near the guide rectangle by per-side edge refinement.
 * For each side it casts `rays` scanlines across a band of +-band*cardWidth,
 * collects gradient peaks, RANSAC-fits up to 3 lines and keeps the OUTERMOST
 * well-supported one (the outer card edge rather than the inner black border
 * or background clutter); the four lines are intersected into corners.
 * Returns {corners, aspect, ok, support} in `img` pixels, or null.
 */
export function findCard(img, guide, { work = CAPTURE_DEFAULTS.workWidth, rays = 48, band = 0.14, minInlier = 0.45, gray = null } = {}) {
  const src = gray || toGray(img);
  const s = Math.min(1, work / src.w);
  const g0 = s === 1 ? src : resizeGray(src, Math.round(src.w * s), Math.round(src.h * s));
  const g = boxBlur3(g0), { w, h, d } = g;
  const G = { x: guide.x * s, y: guide.y * s, w: guide.w * s, h: guide.h * s }, B = Math.max(4, Math.round(band * G.w));
  const sides = [
    { p: (t) => [G.x + t * G.w, G.y], n: [0, -1] },          // top
    { p: (t) => [G.x + G.w, G.y + t * G.h], n: [1, 0] },     // right
    { p: (t) => [G.x + t * G.w, G.y + G.h], n: [0, 1] },     // bottom
    { p: (t) => [G.x, G.y + t * G.h], n: [-1, 0] },          // left
  ];
  const lines = [];
  const prof = new Float32Array(2 * B + 1);
  for (const sd of sides) {
    const pts = [];
    for (let r = 0; r < rays; r++) {
      const t = 0.12 + 0.76 * r / (rays - 1), [px, py] = sd.p(t);
      let mx = 0;
      for (let k = -B, i = 0; k <= B; k++, i++) {
        const x = Math.round(px + sd.n[0] * k), y = Math.round(py + sd.n[1] * k);
        let v = 0;
        if (x >= 1 && y >= 1 && x < w - 1 && y < h - 1) {
          const gx = d[y * w + x + 1] - d[y * w + x - 1], gy = d[(y + 1) * w + x] - d[(y - 1) * w + x];
          v = Math.abs(gx * sd.n[0] + gy * sd.n[1]);
        }
        prof[i] = v;
        if (v > mx) mx = v;
      }
      if (mx < 12) continue;
      for (let i = 1; i < prof.length - 1; i++) {
        if (prof[i] >= 0.3 * mx && prof[i] >= prof[i - 1] && prof[i] > prof[i + 1]) {
          const den = prof[i - 1] - 2 * prof[i] + prof[i + 1], sub = den ? 0.5 * (prof[i - 1] - prof[i + 1]) / den : 0;
          const k = i + sub - B;
          pts.push([px + sd.n[0] * k, py + sd.n[1] * k]);
        }
      }
    }
    const cand = [];
    let rest = pts;
    for (let j = 0; j < 3; j++) {
      const L = ransacLine(rest, 1.2);
      if (!L) break;
      cand.push(L);
      rest = rest.filter((p) => Math.abs(L.nx * p[0] + L.ny * p[1] - L.c) >= 2.5);
    }
    if (!cand.length) return null;
    const top = Math.max(...cand.map((c) => c.inliers)), [mx0, my0] = sd.p(0.5);
    const outward = (L) => {
      const det = L.nx * sd.n[0] + L.ny * sd.n[1];
      return Math.abs(det) < 1e-6 ? -Infinity : (L.c - L.nx * mx0 - L.ny * my0) / det;
    };
    // Lines must run roughly parallel to the side (|det| large) to count.
    const good = cand.filter((c) => c.inliers >= 0.7 * top && Math.abs(c.nx * sd.n[0] + c.ny * sd.n[1]) > 0.9)
      .sort((a, b) => outward(b) - outward(a));
    const L = good[0];
    if (!L || L.inliers < minInlier * rays) return null;
    lines.push(L);
  }
  const corners = [[3, 0], [0, 1], [1, 2], [2, 3]].map(([a, b]) => intersect(lines[a], lines[b]).map((v) => v / s));
  if (corners.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) return null;
  const { w: wq, h: hq } = quadSize(corners);
  const aspect = wq / hq;
  const sizeOk = wq > 0.6 * guide.w && wq < 1.4 * guide.w;
  return { corners, aspect, ok: Math.abs(aspect - CARD_ASPECT) < 0.06 && sizeOk, support: lines.map((l) => l.inliers / rays) };
}

// Deterministic PRNG so findCard gives the same answer for the same frame.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function ransacLine(pts, tol) {
  if (pts.length < 6) return null;
  const rnd = lcg(pts.length * 2654435761);
  let best = null;
  for (let it = 0; it < 200; it++) {
    const a = pts[(rnd() * pts.length) | 0], b = pts[(rnd() * pts.length) | 0];
    if (a === b) continue;
    let nx = b[1] - a[1], ny = a[0] - b[0];
    const L = Math.hypot(nx, ny);
    if (!L) continue;
    nx /= L; ny /= L;
    const c = nx * a[0] + ny * a[1];
    let cnt = 0;
    for (const p of pts) if (Math.abs(nx * p[0] + ny * p[1] - c) < tol) cnt++;
    if (!best || cnt > best.cnt) best = { nx, ny, c, cnt };
  }
  if (!best) return null;
  const inl = pts.filter((p) => Math.abs(best.nx * p[0] + best.ny * p[1] - best.c) < tol);
  // total least squares on the inliers
  const n = inl.length, mx = inl.reduce((s, p) => s + p[0], 0) / n, my = inl.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of inl) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(th), dy = Math.sin(th);
  return { nx: -dy, ny: dx, c: -dy * mx + dx * my, inliers: n };
}

function intersect(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  return [(a.c * b.ny - a.ny * b.c) / det, (a.nx * b.c - a.c * b.nx) / det];
}

/** Art-region dHash of a card quad (cheap, from the analysis frame): "is this still the same card?". */
export function cardArtHash(img, corners) {
  const q = regionQuad(corners, { x0: 0.12, y0: 0.13, x1: 0.88, y1: 0.52 });
  return dHash(toGray(warpQuad(img, q, 48, 32)), 8);
}

// ---------------------------------------------------------------------------
// Auto-capture state machine (pure; the UI feeds it one observation per frame)

/**
 * SEARCHING -> TRACKING (card found) -> STABLE (MAD and corner drift small for
 * N frames) -> CAPTURE (strip sharpness near its recent max) -> COOLDOWN.
 * COOLDOWN only re-arms when the card leaves the frame or the scene changes,
 * and never while the art hash still matches the captured card.
 */
export class AutoCapture {
  constructor(cfg = {}) {
    this.cfg = { ...CAPTURE_DEFAULTS, ...cfg };
    this.reset();
  }

  reset() {
    this.state = "searching";
    this.stableN = 0;
    this.missN = 0;
    this.prevThumb = null;
    this.prevCorners = null;
    this.sharpHist = [];
    this.last = null; // {thumb, artHash}
  }

  /** Enter COOLDOWN after a capture (auto or manual). */
  captured(obs = {}) {
    this.state = "cooldown";
    this.missN = 0;
    this.stableN = 0;
    this.last = { thumb: obs.thumb || this.prevThumb, artHash: obs.artHash || null };
  }

  /** Re-arm explicitly (e.g. after "scan again"). */
  rearm() {
    this.state = "searching";
    this.stableN = 0;
    this.missN = 0;
    this.last = null;
  }

  /**
   * obs = {now, found, corners, thumb, sharp, guideW, artHash?, paused?}
   * Returns {state, capture, hint, mad, drift}.
   */
  step(obs) {
    const c = this.cfg, now = obs.now ?? Date.now();
    const mad = this.prevThumb && obs.thumb ? meanAbsDiff(this.prevThumb, obs.thumb) : 255;
    if (obs.thumb) this.prevThumb = obs.thumb;
    if (Number.isFinite(obs.sharp)) {
      this.sharpHist.push([now, obs.sharp]);
      while (this.sharpHist.length && now - this.sharpHist[0][0] > c.sharpWindowMs) this.sharpHist.shift();
    }
    const out = (state, hint, capture = false, drift = null) => {
      this.state = state;
      return { state, hint, capture, mad, drift };
    };

    if (this.state === "cooldown") {
      // A tilted, glared or half-covered card is reported as weak, not gone:
      // it still counts as present, so a brief dropout never re-arms.
      const present = Boolean(obs.found || obs.weak);
      this.missN = present ? 0 : this.missN + 1;
      const scene = this.last?.thumb && obs.thumb ? meanAbsDiff(this.last.thumb, obs.thumb) : 255;
      if (this.missN >= c.leaveFrames && scene > c.leaveMad) { this.rearm(); return out("searching", "Place the next card in the frame"); }
      // A different card swapped in without leaving the frame: only a found
      // quad whose art hash differs from the captured card re-arms.
      if (scene > c.rearmMad && obs.found && obs.artHash && this.last?.artHash
          && hamming(obs.artHash, this.last.artHash) > c.sameCardBits) {
        this.rearm();
        return out("searching", "Hold the next card steady");
      }
      return out("cooldown", "Done: next card");
    }

    if (obs.paused) { this.stableN = 0; return out(this.state === "cooldown" ? "cooldown" : "paused", "Paused"); }
    if (!obs.found || !obs.corners) {
      this.stableN = 0;
      this.prevCorners = null;
      return out("searching", obs.weak ? "Low contrast: try a lighter background" : "Place a card in the frame");
    }
    const drift = this.prevCorners ? cornerDrift(this.prevCorners, obs.corners) / (obs.guideW || 1) : Infinity;
    this.prevCorners = obs.corners;
    if (mad < c.stableMad && drift < c.cornerDrift) this.stableN++;
    else this.stableN = 0;
    if (this.stableN < c.stableFrames) return out("tracking", "Hold steady", false, drift);
    const max = this.sharpHist.reduce((m, [, v]) => Math.max(m, v), 0);
    const sharp = obs.sharp ?? 0;
    if (sharp >= c.sharpRel * max && sharp >= c.sharpFloor) {
      const r = out("capture", "Capturing", true, drift);
      this.captured(obs); // straight into COOLDOWN: one capture per card
      return r;
    }
    return out("stable", sharp < c.sharpFloor ? "Too blurry: more light or move back a little" : "Focusing…", false, drift);
  }
}

// ---------------------------------------------------------------------------
// Browser helpers (camera, stills, JPEG). These touch DOM globals only when called.

/** What the current browser offers for scanning. */
export function cameraSupport() {
  const g = globalThis;
  return {
    secure: Boolean(g.isSecureContext),
    getUserMedia: Boolean(g.navigator?.mediaDevices?.getUserMedia),
    imageCapture: typeof g.ImageCapture === "function",
    videoFrameCallback: Boolean(g.HTMLVideoElement && "requestVideoFrameCallback" in g.HTMLVideoElement.prototype),
  };
}

/** Rear camera, as high-res as the device allows (4K ideal, then 1080p, then anything). */
export async function openCamera({ width = 3840, height = 2160 } = {}) {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.getUserMedia) throw new Error(globalThis.isSecureContext === false
    ? "The camera needs HTTPS (a secure context)."
    : "This browser has no camera access (getUserMedia).");
  const tries = [
    { facingMode: { ideal: "environment" }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: { ideal: "environment" } },
    true,
  ];
  let last;
  for (const video of tries) {
    try {
      return await md.getUserMedia({ audio: false, video });
    } catch (e) {
      last = e;
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) break;
    }
  }
  throw last || new Error("Could not open the camera");
}

export function stopStream(stream) {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
}

/** true/false when the track says so; null when unknown (iOS reports unreliably). */
export function torchCapability(track) {
  try {
    const caps = track?.getCapabilities?.();
    if (caps && "torch" in caps) return Boolean(caps.torch);
  } catch { /* ignore */ }
  return null;
}

/** Switch the torch; throws if the device refuses. Keep your own on/off state. */
export async function setTorch(track, on) {
  if (!track?.applyConstraints) throw new Error("Torch not supported");
  await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
}

/** Ask for continuous autofocus where the track lists it (Android Chrome). */
export async function preferContinuousFocus(track) {
  try {
    const modes = track?.getCapabilities?.().focusMode;
    if (Array.isArray(modes) && modes.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch { /* ignore */ }
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });

/** Draw a source rect of `src` scaled by k and return {img (RGBA), canvas}. */
function grabRegion(src, rect, k, mk = makeCanvas) {
  const c = mk(rect.w * k, rect.h * k), ctx = ctx2d(c);
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { w: id.width, h: id.height, d: id.data };
}

/** Frame analysis: draws the video at work width and runs findCard + metrics. */
export function createAnalyzer(cfg = {}) {
  const c = { ...CAPTURE_DEFAULTS, ...cfg };
  let work = null, strip = null;
  return function analyze(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const W = c.workWidth, H = Math.round(vh * W / vw), s = W / vw;
    if (!work || work.width !== W || work.height !== H) work = makeCanvas(W, H);
    const wctx = ctx2d(work);
    wctx.drawImage(video, 0, 0, W, H);
    const id = wctx.getImageData(0, 0, W, H), img = { w: W, h: H, d: id.data };
    const gray = toGray(img);
    const guide = guideRect(vw, vh, c.guideFrac), g = { x: guide.x * s, y: guide.y * s, w: guide.w * s, h: guide.h * s };
    let fc = null;
    try { fc = findCard(img, g, { gray }); } catch { fc = null; }
    const ok = Boolean(fc && fc.ok);
    const quad = ok ? fc.corners : null;
    // Sharpness on the guide's bottom strip, drawn from the full-res frame.
    const sr = ok ? quadBounds(regionQuad(scaleQuad(quad, 1 / s), { x0: 0, y0: 0.86, x1: 1, y1: 1 }))
      : { x: guide.x, y: guide.y + guide.h * 0.86, w: guide.w, h: guide.h * 0.14 };
    const sx = Math.max(0, sr.x), sy = Math.max(0, sr.y), sw = Math.min(vw - sx, sr.w), sh = Math.min(vh - sy, sr.h);
    let sharp = 0;
    if (sw > 8 && sh > 4) {
      const k = Math.min(1, 640 / sw), dw = Math.max(8, Math.round(sw * k)), dh = Math.max(4, Math.round(sh * k));
      if (!strip || strip.width !== dw || strip.height !== dh) strip = makeCanvas(dw, dh);
      const sctx = ctx2d(strip);
      sctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
      const sd = sctx.getImageData(0, 0, dw, dh);
      sharp = laplacianVariance(toGray({ w: dw, h: dh, d: sd.data }));
    }
    return {
      vw, vh, guide, found: ok, weak: Boolean(fc && !fc.ok),
      corners: ok ? scaleQuad(quad, 1 / s) : null,  // full-res video pixels
      thumb: thumb64(gray), sharp,
      artHash: ok ? cardArtHash(img, quad) : null,
      guideW: guide.w,
    };
  };
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/**
 * How a vw x vh video frame sits inside a pw x ph still: the video is assumed
 * to be the centred crop of the photo at the same orientation. Returns
 * {s, ox, oy} (photo = video * s + offset) or null when the orientations differ.
 */
export function photoMapping(pw, ph, vw, vh) {
  if (!(pw > 0 && ph > 0 && vw > 0 && vh > 0) || (pw > ph) !== (vw > vh)) return null;
  let s, ox = 0, oy = 0;
  if (pw / ph < vw / vh) { s = pw / vw; oy = (ph - vh * s) / 2; } else { s = ph / vh; ox = (pw - vw * s) / 2; }
  return { s, ox, oy };
}

/**
 * Refine the card corners inside a still photo whose framing differs from the
 * video (Android ImageCapture). The video corners are mapped with
 * photoMapping(), then the card is re-detected in a downscaled copy of the
 * photo: v1 = findCard at 720 px wide around the mapped quad, v2 = detector A2
 * on a copy `photoLongSide` (1440) px long with the mapped quad as the temporal
 * hint (corner order kept as the tracker had it). A re-detection more than
 * maxDrift (8 %) of the card width away from the mapped quad is rejected:
 * null = use the video frame instead.
 * @param {{width:number,height:number}} bitmap the still (ImageBitmap, or any drawable for opts.grab)
 * @param {object} [opts] {det 'v1'|'v2', detOpts (detect() options), grab(src, rect, k) → RGBA
 *   (tests), photoLongSide, maxDrift, info (an object that receives {drift, reason, k})}
 * @returns {number[][]|null} corners in photo pixels
 */
export function mapToPhoto(bitmap, vw, vh, corners, opts = {}) {
  const { det = "v1", detOpts = {}, grab = grabRegion, photoLongSide = CAPTURE_DEFAULTS.photoLongSide, maxDrift = 0.08, info = {} } = opts;
  const pw = bitmap.width, ph = bitmap.height;
  const m = photoMapping(pw, ph, vw, vh);
  if (!m) { info.reason = "orientation"; return null; }
  const mapped = scaleQuad(corners, m.s, m.s, m.ox, m.oy);
  const b = quadBounds(mapped);
  let refined = null;
  if (det === "v2") {
    const k = Math.min(1, photoLongSide / Math.max(pw, ph));
    const small = grab(bitmap, { x: 0, y: 0, w: pw, h: ph }, k);
    const kx = small.w / pw, ky = small.h / ph, short = Math.min(small.w, small.h);
    info.k = k;
    const prev = scaleQuad(mapped, kx, ky);
    // gradient resolution like the 480-px work frame (k=2 there): integer box factor
    const r = detect(small, { ...detOpts, prev, k: Math.max(2, Math.floor(short / 240)) });
    if (!r.found || !r.corners) { info.reason = "not-found"; return null; }
    const rf = refine(small, r.corners, { ...detOpts, scale: Math.max(1, short / 480) });
    const q = rf.corners || r.corners, a = align(q, prev);
    refined = scaleQuad([0, 1, 2, 3].map((i) => q[(i + a.s) & 3]), 1 / kx, 1 / ky);
  } else {
    // Re-detect in a downscaled copy of the photo, using the mapped quad as the guide.
    const k = Math.min(1, 720 / pw);
    const small = grab(bitmap, { x: 0, y: 0, w: pw, h: ph }, k);
    info.k = k;
    const g = { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
    const fc = findCard(small, g, { work: 720 });
    if (!fc || !fc.ok) { info.reason = "not-found"; return null; }
    refined = scaleQuad(fc.corners, 1 / k);
  }
  info.drift = cornerDrift(refined, mapped) / (b.w || 1);
  if (info.drift > maxDrift) { info.reason = "drift"; return null; }
  info.reason = null;
  return refined;
}

/**
 * Grab a still: ImageCapture.takePhoto() where available (Android Chrome, more
 * pixels), else the current video frame (iOS Safari, or preferPhoto:false
 * when the learned box prior makes the video corners exact). Returns
 * {source, w, h, corners, kind, drift, reject} with corners in the still's
 * pixel space (drift/reject: the photo re-detect, for the capture log).
 */
export async function grabStill(video, track, corners, { preferPhoto = true, timeoutMs = 3500, det, detOpts } = {}) {
  const vw = video.videoWidth, vh = video.videoHeight;
  let drift = null, reject = null;
  if (preferPhoto && track && typeof globalThis.ImageCapture === "function" && typeof createImageBitmap === "function") {
    try {
      const ic = new globalThis.ImageCapture(track);
      const blob = await withTimeout(ic.takePhoto(), timeoutMs);
      const bmp = await createImageBitmap(blob);
      const info = {};
      const q = mapToPhoto(bmp, vw, vh, corners, { det: det || scanDetVersion(), detOpts, info });
      drift = Number.isFinite(info.drift) ? Math.round(info.drift * 1e4) / 1e4 : null;
      if (q) return { source: bmp, w: bmp.width, h: bmp.height, corners: q, kind: "photo", drift, reject: null };
      reject = info.reason || "unknown";
      bmp.close?.();
    } catch { reject = reject || "error"; /* fall back to the video frame */ }
  }
  return { source: video, w: vw, h: vh, corners, kind: "video", drift, reject };
}

/** Warp the region `region` (card fractions) of a still into an RGBA image. */
function warpRegion(still, corners, region, outW, outH, oversample = 1.3) {
  const q = region ? regionQuad(corners, region) : corners;
  const b = quadBounds(q), size = quadSize(q);
  // Clip the source rect to the still; warpQuad clamps sampling outside it.
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
  const w = Math.min(still.w, Math.ceil(b.x + b.w)) - x, h = Math.min(still.h, Math.ceil(b.y + b.h)) - y;
  if (w < 4 || h < 4) throw new Error("Card is outside the frame");
  const k = Math.min(1, (outW * oversample) / size.w);
  const img = grabRegion(still.source, { x, y, w, h }, k);
  return warpQuad(img, scaleQuad(q, k, k, -x * k, -y * k), outW, outH);
}

/** RGBA image -> base64 JPEG (no data: prefix). */
export function encodeJpeg(img, quality) {
  const c = makeCanvas(img.w, img.h);
  ctx2d(c).putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
  const url = c.toDataURL("image/jpeg", quality);
  return url.slice(url.indexOf(",") + 1);
}

/**
 * Full capture: still -> rectified 1000x1400 card (q85) + high-res bottom
 * strip (q92). `corners` are the video-space corners from the analyser (or the
 * guide quad for a manual shot without a detected card; v2: the tracker-smoothed
 * corners). cfg: CAPTURE_DEFAULTS overrides plus grabStill options
 * ({preferPhoto, det, detOpts}; v2 analyzers hand them out via captureOpts()).
 * Returns {card, strip, cardPreview (data URL), kind, stripSize, drift, reject}.
 */
export async function captureCard(video, track, corners, cfg = {}) {
  const c = { ...CAPTURE_DEFAULTS, ...cfg };
  const still = await grabStill(video, track, corners, cfg);
  try {
    const [cw, ch] = c.cardSize;
    const card = warpRegion(still, still.corners, null, cw, ch);
    const r = c.stripRegion;
    const stripQ = regionQuad(still.corners, r), ss = quadSize(stripQ);
    const sw = Math.max(200, Math.min(c.stripMaxWidth, Math.round(ss.w)));
    const sh = Math.max(40, Math.round(sw * ((r.y1 - r.y0) * 88) / ((r.x1 - r.x0) * 63)));
    const strip = warpRegion(still, still.corners, r, sw, sh, 1);
    const cardB64 = encodeJpeg(card, c.cardQuality);
    return {
      card: cardB64,
      strip: encodeJpeg(strip, c.stripQuality),
      cardPreview: `data:image/jpeg;base64,${cardB64}`,
      kind: still.kind,
      stripSize: [sw, sh],
      drift: still.drift ?? null,
      reject: still.reject ?? null,
    };
  } finally {
    if (still.source && still.source !== video) still.source.close?.();
  }
}

// ---------------------------------------------------------------------------
// v2: detector A2 + tracker + learned box prior

/** localStorage key that selects the detector path ("v1" | "v2"). */
export const DET_STORAGE_KEY = "mtg.scan.det";

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/**
 * Which detector path the scanner runs: ?det=v1|v2 in the URL (remembered in
 * localStorage, because a home-screen PWA drops query parameters), else
 * localStorage mtg.scan.det, else 'v2'.
 * @param {{search?: string, storage?: Storage|null}} [env] overrides (tests)
 * @returns {'v1'|'v2'}
 */
export function scanDetVersion(env = {}) {
  const storage = "storage" in env ? env.storage : defaultStorage();
  let q = null;
  try {
    const search = env.search ?? globalThis.location?.search ?? "";
    q = new URLSearchParams(search).get("det");
  } catch { q = null; }
  if (q === "v1" || q === "v2") {
    try { storage?.setItem(DET_STORAGE_KEY, q); } catch { /* private mode */ }
    return q;
  }
  try {
    const v = storage?.getItem(DET_STORAGE_KEY);
    if (v === "v1" || v === "v2") return v;
  } catch { /* blocked storage */ }
  return "v2";
}

// bilinear luma sample of an RGBA image (continuous coords, edge clamped)
function lumAt(img, x, y) {
  const { w, h, d } = img;
  x = Math.min(w - 1.001, Math.max(0, x - 0.5)); y = Math.min(h - 1.001, Math.max(0, y - 0.5));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
  const L = (o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  return (L(i) * (1 - fx) + L(i + 4) * fx) * (1 - fy) + (L(j) * (1 - fx) + L(j + 4) * fx) * fy;
}

/**
 * 12x16 luma thumbnail of a quad's region (4x4 bilinear samples per cell): the
 * card-region stillness signal of capture.js (ProbeController cmad).
 */
export function quadThumb(img, q, TW = 12, TH = 16) {
  const t = new Float32Array(TW * TH);
  for (let gy = 0; gy < TH; gy++) for (let gx = 0; gx < TW; gx++) {
    let s = 0;
    for (let k = 0; k < 16; k++) {
      const u = (gx + ((k & 3) + 0.5) / 4) / TW, v = (gy + ((k >> 2) + 0.5) / 4) / TH;
      const px = (1 - v) * ((1 - u) * q[0][0] + u * q[1][0]) + v * ((1 - u) * q[3][0] + u * q[2][0]);
      const py = (1 - v) * ((1 - u) * q[0][1] + u * q[1][1]) + v * ((1 - u) * q[3][1] + u * q[2][1]);
      s += lumAt(img, px, py);
    }
    t[gy * TW + gx] = s / 16;
  }
  return t;
}

/** Work-frame size for a vw x vh video at `short` px on the short side (never upscaled). */
export function workSize(vw, vh, short = CAPTURE_DEFAULTS.workShort) {
  const s = Math.min(1, short / Math.min(vw, vh));
  return { W: Math.max(1, Math.round(vw * s)), H: Math.max(1, Math.round(vh * s)), s };
}

/**
 * Frame analysis for the v2 path. Per analyze(now): the video is drawn at 480 px
 * short side, detect(img, prior.opts(w, h)) → BoxPrior.noteFrame → QuadTracker;
 * the prior observes each new stable outline while it is inactive (as in the
 * research replay). Sharpness is measured on the tracked quad's bottom 14 % at
 * full resolution. Glare (detection only, ~45 ms on a desktop CPU) runs on a
 * rectified 500x700 card only once the track has been stable for glareDelayMs
 * (800: a capture normally fires ~3 frames after stable, so the hint is for a
 * card that sits still without being taken) and then every glareEveryMs (1500).
 *
 * FrameAnalysis (capture.js ProbeController.step() input): {vw, vh, found
 * (a tracked outline this frame), weak (found, detection below the bar),
 * accepted, stable, corners (smoothed, video px, TL,TR,BR,BL), rawCorners,
 * jitter, drift, mode, score, orientConf, thumb (24x40), cardThumb (12x16),
 * sharp, glare {advice, code, regions}, priorQuad (video px | null),
 * priorLearned (box mode active), now, ms}.
 *
 * The learned box persists per device in localStorage mtg.scan.prior:
 * loadPrior() on create, savePrior() after each accepted capture (it adds that
 * capture to the prior first: the given video corners, else the last frame's
 * accepted track, once per stable run).
 *
 * @param {HTMLVideoElement|{videoWidth:number, videoHeight:number}} video
 * @param {object} [opts] {workShort, storage, makeCanvas (tests), prior/tracker (instances),
 *   priorOpts, trackerOpts, glare (true), glareDelayMs (800), glareEveryMs (1500), now}
 */
export function createDetAnalyzer(video, opts = {}) {
  const workShort = opts.workShort || CAPTURE_DEFAULTS.workShort;
  const mk = opts.makeCanvas || makeCanvas;
  const storage = "storage" in opts ? opts.storage : defaultStorage();
  const clock = opts.now || (() => (globalThis.performance ? performance.now() : Date.now()));
  const prior = opts.prior || new BoxPrior({ mode: "auto", ...(opts.priorOpts || {}) });
  const tracker = opts.tracker || new QuadTracker(opts.trackerOpts || {});
  const glareOn = opts.glare !== false, glareEveryMs = opts.glareEveryMs ?? 1500, glareDelayMs = opts.glareDelayMs ?? 800;
  const noGlare = () => ({ advice: null, code: "ok", regions: null });
  let work = null, strip = null, last = null, wasStable = false, runId = 0, addedRun = -1;
  let glare = noGlare(), glareAt = -Infinity, stableSince = null;

  const toVideo = (q, s) => (q ? q.map(([x, y]) => [x / s, y / s]) : null);

  function sharpness(vw, vh, cornersV) {
    const sr = quadBounds(regionQuad(cornersV, { x0: 0, y0: 0.86, x1: 1, y1: 1 }));
    const sx = Math.max(0, sr.x), sy = Math.max(0, sr.y), sw = Math.min(vw - sx, sr.w), sh = Math.min(vh - sy, sr.h);
    if (!(sw > 8 && sh > 4)) return 0;
    const k = Math.min(1, 640 / sw), dw = Math.max(8, Math.round(sw * k)), dh = Math.max(4, Math.round(sh * k));
    if (!strip || strip.width !== dw || strip.height !== dh) strip = mk(dw, dh);
    const sctx = ctx2d(strip);
    sctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    const sd = sctx.getImageData(0, 0, dw, dh);
    return laplacianVariance(toGray({ w: dw, h: dh, d: sd.data }));
  }

  // full-res video region around `quad`, drawn so the card is ~targetW*1.3 wide, rectified to outW x outH
  function rectify(quad, targetW, outW, outH) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
    const w = Math.min(vw, Math.ceil(Math.max(...xs))) - x, h = Math.min(vh, Math.ceil(Math.max(...ys))) - y;
    if (!(w >= 4 && h >= 4)) return null;
    const k = Math.min(1, (targetW * 1.3) / quadSize(quad).w);
    const img = grabRegion(video, { x, y, w, h }, k, mk);
    const kx = img.w / w, ky = img.h / h;
    return warpQuad(img, quad.map(([a, b]) => [(a - x) * kx, (b - y) * ky]), outW, outH);
  }

  function analyze(now = clock()) {
    const t0 = clock();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const { W, H, s } = workSize(vw, vh, workShort);
    if (!work || work.width !== W || work.height !== H) work = mk(W, H);
    const wctx = ctx2d(work);
    wctx.drawImage(video, 0, 0, W, H);
    const id = wctx.getImageData(0, 0, W, H), img = { w: W, h: H, d: id.data };
    const po = prior.opts(W, H);
    let r;
    try { r = detect(img, po); } catch { r = { found: false, weak: false, corners: null }; }
    prior.noteFrame(r);
    const tr = tracker.update(r);
    if (tr.stable && !wasStable) {
      runId++;
      stableSince = now;
      if (!prior.active && tr.corners) prior.observe(tr.corners, W, H);
    }
    wasStable = Boolean(tr.stable);
    const seen = Boolean(tr.corners && tr.seen && tr.found);
    const corners = seen ? toVideo(tr.corners, s) : null;
    let sharp = null;
    if (corners) { try { sharp = sharpness(vw, vh, corners); } catch { sharp = null; } }
    const stable = Boolean(seen && tr.stable);
    if (!seen) glare = noGlare();
    else if (glareOn && stable && now - stableSince >= glareDelayMs && now - glareAt >= glareEveryMs) {
      glareAt = now;
      try {
        const card = rectify(corners, 500, 500, 700);
        if (card) {
          const g = glareMap(card), code = captureAdvice(g, null);
          glare = { advice: code === "ok" ? null : ADVICE_HINTS[code], code, regions: g.regions };
        }
      } catch { /* glare is advisory only */ }
    }
    const pq = (po.prior && po.prior.quad) || prior.learnedQuad(W, H);
    last = { W, H, s, tr, seen, mode: r.mode || "free", runId };
    return {
      vw, vh, found: seen, weak: Boolean(seen && !tr.accepted), accepted: Boolean(seen && tr.accepted), stable,
      corners, rawCorners: r.corners ? toVideo(r.corners, s) : null,
      jitter: Number.isFinite(tr.jitter) ? tr.jitter : null, drift: Number.isFinite(tr.drift) ? tr.drift : null,
      mode: r.mode || "free", score: Number.isFinite(r.score) ? r.score : null,
      orientConf: Number.isFinite(r.orientConf) ? r.orientConf : null,
      thumb: frameThumb(img), cardThumb: seen ? quadThumb(img, tr.corners) : null,
      sharp, glare, priorQuad: pq ? toVideo(pq, s) : null, priorLearned: Boolean(prior.active),
      now, ms: clock() - t0,
    };
  }

  /** Hash source for capture.js: full-res crop around `quad` (~488x680 card) area-reduced to 244x340 (RGB, channels 3). */
  function hashCrop(quad) {
    if (!quad) return null;
    const card = rectify(quad, 488, 488, 680);
    if (!card) return null;
    const data = areaResample({ width: 488, height: 680, channels: 4, data: card.d }, [0, 0, 1, 1], 244, 340);
    return { width: 244, height: 340, channels: 3, data };
  }

  function loadPrior() {
    try {
      const raw = storage?.getItem(PRIOR_STORAGE_KEY);
      return raw ? prior.restore(JSON.parse(raw)) : false;
    } catch { return false; }
  }

  /**
   * After an accepted capture: add it to the prior (video corners, else the last
   * frame's accepted track once per stable run), then persist the learned box.
   */
  function savePrior(cornersV = null) {
    const L = last;
    if (L) {
      let q = null;
      if (cornersV) q = cornersV.map(([x, y]) => [x * L.s, y * L.s]);
      else if (L.seen && L.tr.accepted && L.runId !== addedRun) q = L.tr.corners;
      if (q) { prior.add(q, L.W, L.H, L.mode === "box"); addedRun = L.runId; }
    }
    try {
      const j = prior.toJSON();
      if (j) storage?.setItem(PRIOR_STORAGE_KEY, JSON.stringify(j));
      else storage?.removeItem(PRIOR_STORAGE_KEY);
    } catch { /* storage full or blocked */ }
  }

  /** New session (camera restart): tracker cleared, the learned box re-read from storage. */
  function reset() {
    tracker.reset();
    prior.caps = []; prior.misses = 0; prior.dormant = false;
    wasStable = false; last = null; addedRun = -1;
    glare = noGlare(); glareAt = -Infinity; stableSince = null;
    loadPrior();
  }

  /** Forget the learned box on this device. */
  function forgetPrior() {
    prior.forget();
    try { storage?.removeItem(PRIOR_STORAGE_KEY); } catch { /* ignore */ }
  }

  /** captureCard/grabStill options: the video frame while the box prior is active (corners exact), else takePhoto + A2 re-detect. */
  function captureOpts() {
    return { det: "v2", preferPhoto: !prior.active };
  }

  /** The last analysed work frame (480 px short side) as base64 JPEG (record session), or null. */
  function frameJpeg(quality = 0.7) {
    if (!work || typeof work.toDataURL !== "function") return null;
    const url = work.toDataURL("image/jpeg", quality);
    return url.slice(url.indexOf(",") + 1);
  }

  loadPrior();
  return { analyze, prior, tracker, reset, hashCrop, savePrior, loadPrior, forgetPrior, captureOpts, frameJpeg };
}

// ---------------------------------------------------------------------------
// Glare (detection only), ported from the scanner research (glare.mjs): a
// specular highlight on the collector line or the title is fatal for OCR, one
// on the art hurts the fingerprint. Input: a rectified card {w, h, d RGBA}.

/** Card layout (fractions of the rectified card). */
export const CARD_REGIONS = Object.freeze({
  title: Object.freeze({ x0: 0.05, y0: 0.035, x1: 0.95, y1: 0.105 }),
  art: Object.freeze({ x0: 0.07, y0: 0.11, x1: 0.93, y1: 0.555 }),
  typeLine: Object.freeze({ x0: 0.05, y0: 0.555, x1: 0.95, y1: 0.625 }),
  textBox: Object.freeze({ x0: 0.07, y0: 0.625, x1: 0.93, y1: 0.92 }),
  collector: Object.freeze({ x0: 0.03, y0: 0.925, x1: 0.97, y1: 0.995 }),
});

export const GLARE_DEFAULTS = Object.freeze({
  workWidth: 500, border: 0.025, whitePct: 0.92, whiteMargin: 12, coreMin: 215, coreMax: 249, coreSat: 0.22,
  growDrop: 28, growSat: 0.32, growAboveWhite: 6, openRadius: 2, minArea: 0.00012, ringNear: 3, ringFar: 9,
  minContrast: 22, peakMin: 240, minFill: 0.2,
});

/** Per-region glare fraction that blocks a capture (research values; G3 validates them). */
export const ADVICE_LIMITS = Object.freeze({ collector: 0.004, title: 0.02, art: 0.05, sharpFloor: 60 });

export const ADVICE_HINTS = Object.freeze({
  ok: "",
  "glare-collector": "Reflection on the bottom line: tilt slightly",
  "glare-title": "Reflection on the name: tilt slightly",
  "glare-art": "Reflection on the picture: tilt slightly",
  "too-blurry": "Too blurry: hold still or more light",
});

function glarePlanes(img, f) {
  const mw = Math.floor(img.w / f), mh = Math.floor(img.h / f), n = mw * mh;
  const Y = new Float32Array(n), S = new Float32Array(n), d = img.d, inv = 1 / (f * f);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    let r = 0, g = 0, b = 0;
    for (let yy = 0; yy < f; yy++) {
      let p = ((y * f + yy) * img.w + x * f) * 4;
      for (let xx = 0; xx < f; xx++, p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; }
    }
    r *= inv; g *= inv; b *= inv;
    const i = y * mw + x, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    S[i] = mx > 1 ? (mx - mn) / mx : 0;
  }
  return { Y, S, mw, mh };
}

// separable square erosion ('min') / dilation ('max') of a 0/1 mask; outside pixels are ignored
function morph(mask, w, h, r, op) {
  if (r <= 0) return mask.slice();
  const pass = (src, horiz) => {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = op === "min" ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const m = src[yy * w + xx];
        if (op === "min" ? !m : m) { v = op === "min" ? 0 : 1; break; }
      }
      dst[y * w + x] = v;
    }
    return dst;
  };
  return pass(pass(mask, true), false);
}

function percentileY(Y, w, inner, p) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = inner.y0; y < inner.y1; y++) for (let x = inner.x0; x < inner.x1; x++) { hist[Math.min(255, Y[y * w + x] | 0)]++; n++; }
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; }
  return 255;
}

/**
 * Specular highlights on a rectified card: compact, near-saturated, low-saturation
 * blobs brighter than the card's paper white and than their surroundings (white
 * borders, thin white text and white frames do not fire).
 * @returns {{mask:Uint8Array, mw:number, mh:number, fraction:number, regions:object, whiteRef:number, overexposed:boolean}}
 */
export function glareMap(rgba, opts = {}) {
  const o = { ...GLARE_DEFAULTS, ...opts };
  const f = Math.max(1, Math.round(rgba.w / o.workWidth));
  const { Y, S, mw, mh } = glarePlanes(rgba, f);
  const n = mw * mh, bx = Math.round(o.border * mw);
  const inner = { x0: bx, y0: bx, x1: mw - bx, y1: mh - bx };
  const whiteRef = percentileY(Y, mw, inner, o.whitePct);
  const coreT = Math.min(o.coreMax, Math.max(o.coreMin, whiteRef + o.whiteMargin));
  // never grow into paper white: that would swallow white text boxes next to a highlight
  const growT = Math.max(coreT - o.growDrop, whiteRef + o.growAboveWhite);
  const core = new Uint8Array(n), grow = new Uint8Array(n);
  for (let y = inner.y0; y < inner.y1; y++) for (let x = inner.x0; x < inner.x1; x++) {
    const i = y * mw + x;
    if (Y[i] >= coreT && S[i] <= o.coreSat) core[i] = 1;
    if (Y[i] >= growT && S[i] <= o.growSat) grow[i] = 1;
  }
  const opened = morph(morph(core, mw, mh, o.openRadius, "min"), mw, mh, o.openRadius, "max");
  // hysteresis grow from the opened cores, then label components (4-connected)
  const label = new Int32Array(n), queue = new Int32Array(n), comps = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!opened[s0] || !core[s0] || label[s0]) continue;
    const id = comps.length + 1;
    let qh = 0, qt = 0; queue[qt++] = s0; label[s0] = id;
    let area = 0, sumY = 0, maxY = 0, x0 = mw, y0 = mh, x1 = 0, y1 = 0;
    while (qh < qt) {
      const i = queue[qh++], x = i % mw, y = (i / mw) | 0;
      area++; sumY += Y[i]; if (Y[i] > maxY) maxY = Y[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, y > 0 ? i - mw : -1, y < mh - 1 ? i + mw : -1];
      for (const j of nb) if (j >= 0 && !label[j] && grow[j]) { label[j] = id; queue[qt++] = j; }
    }
    comps.push({ id, area, maxY, meanY: sumY / area, bbox: [x0, y0, x1, y1], ringSum: 0, ringN: 0 });
  }
  if (comps.length) {
    // ring contrast: multi-source BFS outward (Voronoi labels); ring pixels at ringNear..ringFar vote
    const dist = new Uint8Array(n).fill(255), own = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (label[i]) { dist[i] = 0; own[i] = label[i]; queue[qt++] = i; }
    while (qh < qt) {
      const i = queue[qh++], dd = dist[i];
      if (dd >= o.ringFar) continue;
      const x = i % mw, y = (i / mw) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, y > 0 ? i - mw : -1, y < mh - 1 ? i + mw : -1];
      for (const j of nb) if (j >= 0 && dist[j] === 255) {
        dist[j] = dd + 1; own[j] = own[i]; queue[qt++] = j;
        if (dd + 1 >= o.ringNear) { const c = comps[own[i] - 1]; c.ringSum += Y[j]; c.ringN++; }
      }
    }
  }
  const minArea = Math.max(4, o.minArea * n), keep = new Uint8Array(comps.length + 1);
  for (const c of comps) {
    const ring = c.ringN ? c.ringSum / c.ringN : c.meanY;
    const fill = c.area / ((c.bbox[2] - c.bbox[0] + 1) * (c.bbox[3] - c.bbox[1] + 1));
    if (c.area >= minArea && c.meanY - ring >= o.minContrast && c.maxY >= o.peakMin && fill >= o.minFill) keep[c.id] = 1;
  }
  const mask = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) if (label[i] && keep[label[i]]) { mask[i] = 1; total++; }
  const regions = {};
  for (const [k, r] of Object.entries(CARD_REGIONS)) {
    const xa = Math.floor(r.x0 * mw), xb = Math.ceil(r.x1 * mw), ya = Math.floor(r.y0 * mh), yb = Math.ceil(r.y1 * mh);
    let c = 0, m = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { c++; m += mask[y * mw + x]; }
    regions[k] = c ? m / c : 0;
  }
  const innerN = (inner.x1 - inner.x0) * (inner.y1 - inner.y0);
  return { mask, mw, mh, fraction: total / innerN, regions, whiteRef, overexposed: whiteRef >= 245 };
}

/**
 * Capture advice from a glareMap and (optionally) the strip sharpness.
 * @returns {'ok'|'glare-collector'|'glare-title'|'glare-art'|'too-blurry'} (hint: ADVICE_HINTS[code])
 */
export function captureAdvice(glare, sharpness, limits = {}) {
  const L = { ...ADVICE_LIMITS, ...limits };
  if (Number.isFinite(sharpness) && sharpness < L.sharpFloor) return "too-blurry";
  const r = glare?.regions ?? {};
  if ((r.collector ?? 0) > L.collector) return "glare-collector";
  if ((r.title ?? 0) > L.title) return "glare-title";
  if ((r.art ?? 0) > L.art) return "glare-art";
  return "ok";
}

// ---------------------------------------------------------------------------
// Scan sounds: a short blip when a scan is staged, a "cha-ching" when the card
// is worth at least the threshold. Synthesized with Web Audio (no files).

/** Per-device sound settings (the UI keeps them in localStorage mtg.scan.sound). */
export const SOUND_DEFAULTS = Object.freeze({ enabled: true, threshold: 5 });
const STAGED = new Set(["auto", "suggest", "confirmed"]);

/**
 * Which sound a scan answer gets (pure).
 * `res`: the POST /api/scan response {scan, duplicate, result: {price_eur}}, or a
 * +1 ({increment: true, price_eur} or the incremented scan row, last_action
 * 'increment'). Staged auto/suggest/confirmed rows and +1s sound (cash when
 * price_eur >= settings.threshold, default 5); review/failed rows, duplicate
 * prompts, nothing staged and settings.enabled === false stay silent.
 * @returns {'cash'|'success'|null}
 */
export function chooseScanSound(res, settings = {}) {
  if (!res || typeof res !== "object") return null;
  const cfg = { ...SOUND_DEFAULTS, ...(settings || {}) };
  if (cfg.enabled === false) return null;
  if (res.duplicate) return null;
  const isIncrement = res.increment === true || res.kind === "increment" || res.last_action === "increment";
  if (!isIncrement && (!res.scan || !STAGED.has(res.scan.match_status))) return null;
  const price = [res.price_eur, res.result?.price_eur, res.scan?.price_eur].find((v) => typeof v === "number" && Number.isFinite(v));
  const t = cfg.threshold === null || cfg.threshold === "" ? NaN : Number(cfg.threshold);
  const thr = Number.isFinite(t) ? t : SOUND_DEFAULTS.threshold;
  return price !== undefined && price >= thr ? "cash" : "success";
}

/**
 * Web Audio scan sounds. unlock() on the user's Start tap (iOS only plays
 * audio after a gesture); play('success'|'cash'). Never throws, never blocks;
 * a no-op without AudioContext. Asks for the 'ambient' audio session where
 * Safari offers it, so the silent switch mutes it.
 * @param {{AudioContext?: Function}} [env] (tests)
 */
export function createScanSounds(env = {}) {
  const AC = "AudioContext" in env ? env.AudioContext : (globalThis.AudioContext ?? globalThis.webkitAudioContext);
  let ctx = null;

  function ensure() {
    if (ctx || typeof AC !== "function") return ctx;
    try {
      try { if (globalThis.navigator?.audioSession) globalThis.navigator.audioSession.type = "ambient"; } catch { /* ignore */ }
      ctx = new AC();
    } catch { ctx = null; }
    return ctx;
  }

  async function unlock() {
    try {
      const c = ensure();
      if (!c) return;
      // iOS also reports "interrupted" (calls, other audio); resume from any non-running state
      if (c.state !== "running" && c.resume) await c.resume();
      // a silent one-sample buffer fully unlocks older iOS
      const b = c.createBuffer(1, 1, c.sampleRate || 44100), s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch { /* audio is optional */ }
  }

  function tone(c, out, t, freq, dur, peak, type = "sine") {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(c, out, t, dur, peak, hp) {
    const sr = c.sampleRate || 44100, n = Math.max(1, Math.round(sr * dur)), b = c.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = b; f.type = "highpass"; f.frequency.setValueAtTime(hp, t);
    g.gain.setValueAtTime(peak, t);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur);
  }

  function play(kind) {
    try {
      const c = ensure();
      if (!c || (kind !== "success" && kind !== "cash")) return;
      if (c.state !== "running" && c.resume) Promise.resolve(c.resume()).catch(() => {});
      const t = (c.currentTime || 0) + 0.01, out = c.createGain();
      out.gain.setValueAtTime(0.5, t);
      out.connect(c.destination);
      if (kind === "success") {
        // two-tone blip (A5 → E6), ~150 ms
        tone(c, out, t, 880, 0.08, 0.35);
        tone(c, out, t + 0.07, 1318.5, 0.09, 0.35);
      } else {
        // "cha": two short mechanical noise bursts; "ching": inharmonic bell partials; ~400 ms
        noise(c, out, t, 0.06, 0.5, 2500);
        noise(c, out, t + 0.07, 0.04, 0.35, 4000);
        for (const [m, a, d] of [[1, 0.32, 0.3], [1.5, 0.1, 0.24], [2.76, 0.12, 0.2], [5.4, 0.06, 0.12]]) tone(c, out, t + 0.1, 1975.5 * m, d, a);
      }
    } catch { /* never break the scan flow */ }
  }

  return { unlock, play };
}
