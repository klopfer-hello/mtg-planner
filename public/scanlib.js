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
function grabRegion(src, rect, k) {
  const c = makeCanvas(rect.w * k, rect.h * k), ctx = ctx2d(c);
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
 * Try to refine the card corners inside a still photo whose framing differs
 * from the video (Android ImageCapture). Video is assumed to be the centred
 * crop of the photo at the same orientation; returns null if that fails.
 */
function mapToPhoto(bitmap, vw, vh, corners) {
  const pw = bitmap.width, ph = bitmap.height;
  if ((pw > ph) !== (vw > vh)) return null;
  let s, ox = 0, oy = 0;
  if (pw / ph < vw / vh) { s = pw / vw; oy = (ph - vh * s) / 2; } else { s = ph / vh; ox = (pw - vw * s) / 2; }
  const mapped = scaleQuad(corners, s, s, ox, oy);
  const b = quadBounds(mapped);
  // Re-detect in a downscaled copy of the photo, using the mapped quad as the guide.
  const k = Math.min(1, 720 / pw);
  const small = grabRegion(bitmap, { x: 0, y: 0, w: pw, h: ph }, k);
  const g = { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
  const fc = findCard(small, g, { work: 720 });
  if (!fc || !fc.ok) return null;
  const refined = scaleQuad(fc.corners, 1 / k);
  if (cornerDrift(refined, mapped) > 0.08 * b.w) return null;
  return refined;
}

/**
 * Grab a still: ImageCapture.takePhoto() where available (Android Chrome, more
 * pixels), else the current video frame (iOS Safari). Returns
 * {source, w, h, corners, kind} with corners in the still's pixel space.
 */
export async function grabStill(video, track, corners, { preferPhoto = true, timeoutMs = 3500 } = {}) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (preferPhoto && track && typeof globalThis.ImageCapture === "function" && typeof createImageBitmap === "function") {
    try {
      const ic = new globalThis.ImageCapture(track);
      const blob = await withTimeout(ic.takePhoto(), timeoutMs);
      const bmp = await createImageBitmap(blob);
      const q = mapToPhoto(bmp, vw, vh, corners);
      if (q) return { source: bmp, w: bmp.width, h: bmp.height, corners: q, kind: "photo" };
      bmp.close?.();
    } catch { /* fall back to the video frame */ }
  }
  return { source: video, w: vw, h: vh, corners, kind: "video" };
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
 * guide quad for a manual shot without a detected card).
 * Returns {card, strip, cardPreview (data URL), kind, stripSize}.
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
    };
  } finally {
    if (still.source && still.source !== video) still.source.close?.();
  }
}
