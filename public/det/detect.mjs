// det/detect.mjs: card detector for the camera scanner (browser ES module, no deps).
//
// Why it exists: the scanner must find a card anywhere in the camera frame, at
// any angle, on a table or inside a scan box where a black-bordered card lies
// on a black stack. The removed v1 guide-frame finder needed the card centred
// in the guide and lost dark-framed cards in a box. This is
// detector "A2" from the scanner research (synthetic scenes, then replayed and
// tuned on real phone captures). Debug output and an unused background model
// hook were removed. One deliberate change (outerEdge, priorInnerSlack): on a
// black box the research version's free mode outlined black-bordered cards by
// their inner frame or by the platform ring around them (real box frames:
// 0/12 corners within 5%, identify AUTO on 4/27 cards of a box session); it
// now places the edge from the inner frame + border model when the surround is
// dark (11/12, 22/27). A second one (fullResRetry, 0.7.0-beta.5): a free-mode
// outline below 0.9 confidence on a > 200,000 px frame is re-checked with a
// full-resolution gradient (see DEFAULTS). With the options {outerEdge:false,
// priorInnerSlack:1, fullResRetry:0} the results equal the research version
// (test/detector.test.js checks both when the research copy is available).
//
// API: detect(rgba, opts) -> {found, weak, corners (TL,TR,BR,BL), score, mode,
// orientConf, landscape, ms, ...}; refine(rgbaFull, roughCorners, opts) ->
// {corners, ok, ms, anchored?}. rgba = {w, h, d: Uint8ClampedArray|Uint8Array}.
// Coordinates are continuous: pixel (i,j) covers [i,i+1]x[j,j+1].
//
// Pipeline, free mode (card anywhere):
//   1. colour-aware gradient (luma + R-B chroma, binomial blur, Sobel, NMS)
//   2. LSD-like segments, 3. collinear segments merged into lines
//   4. quad hypotheses from two roughly opposite line pairs (Zhang-He aspect
//      with an assumed focal length)
//   5. pixel re-scoring; nested quads -> the outermost well-supported one; the
//      layout correlation of the rectified quad joins the selection (a
//      card-shaped tile loses against a real card that is off-centre)
//   5b. dark surround (black border on a black box): the outline from the
//      inner frame + border model (frameAnchor) replaces an edge fit that
//      landed on the inner frame or the platform ring; when the chosen quad
//      is only part of the card, a larger anchorable hypothesis takes over.
//      refine() repeats the check at full resolution.
//   6. outward snap inner frame -> outer card edge (all four sides, or a side
//      whose band looks like the card border), per-side refinement, and a
//      180-degree orientation classifier (orientfeat.mjs + orientw.mjs).
// Box mode (opts.mode = 'box' or opts.prior = {center, angle, scaleRange,
// weight, quad}; track.mjs BoxPrior supplies it once it has learned a box):
//   - only lines near the prior's card axes, only quads near its centre and scale
//   - no outward snap (it walks border -> ring -> platform in a black box);
//     frameAnchor() places the card edge one border width outside the inner
//     frame instead (P.borderMM, bottom wider)
//   - dark-frame cards (no bright frame on 3 sides): the last box capture's
//     outline (prior.quad)
// The temporal layer (QuadTracker, BoxPrior) is in track.mjs.
//
// Weights: template.mjs and orientw.mjs are derived from Scryfall card images
// (see their headers). One detect() runs at a time per thread: scratch buffers
// are module-level and reused between frames.

import { ORIENT_TS, ORIENT_GS, ORIENT_W, ORIENT_H } from './template.mjs';
import { orientFeatures, orientScore } from './orientfeat.mjs';
import { ORIENT_W2 } from './orientw.mjs';

const CARD_R = 63 / 88;
// Math.hypot is slow in V8; these are plenty accurate for pixel geometry
const hyp2 = (x, y) => Math.sqrt(x * x + y * y);
const hyp3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const now = () => (globalThis.performance ? performance.now() : Date.now());

export const DEFAULTS = Object.freeze({
  focalRel: 0.75,       // assumed focal length / long image side (phone main camera ~ 70 deg HFOV)
  aspectTol: 0.14,      // |r - 63/88| / (63/88) accepted for the rectified short/long ratio
  minSideRel: 0.07,     // shortest accepted side, fraction of min(w,h)
  tolDeg: 22.5,         // LSD angle tolerance
  minSegLen: 9,         // px at analysis resolution
  maxLines: 56,
  oppDeg: 38,           // opposite sides may converge by this much (perspective)
  cornerDeg: 38,        // min angle between the two side directions
  topCands: 40,         // hypotheses re-scored on pixels
  minScore: 0.42,       // found threshold
  refine: true,         // per-side refinement at analysis resolution
  snap: true,           // outward snap from an inner frame line to the outer card edge (per side)
  snapFull: true,       // run the outward snap again at full resolution in refine()
  hiddenBorderMM: 0,    // assumed border width when the outer edge is invisible (black border on black mat)
  hiddenRimStd: 1e9,
  hiddenMin: 3,
  bandLo: 0.3,
  bandStd: 8,
  bandDev: 15,
  bandOutl: 0.4,
  snapMaxMM: 7.5,
  snapRel: 0.06,
  snapContrast: 10,
  snapRimStep: 15,
  snapMinSides: 4,
  snapPartialTol: 22,
  snapOwnTol: 70,
  snapPartialMode: 'or',
  snapBlackBand: true,   // v2: a partial snap side is kept when its band matches the border rim colour (lab dist)      // v2: outward snap only when this many sides agree (1 = v1 per-side behaviour)
  refBand: 0.025,
  refAng: 8,
  devW: 1.0,
  extW: 0.4,
  selRel: 0.7,          // candidates within this fraction of the best score compete on centrality
  selMax: 4,            // v2: at most this many compete (each costs one layout rectification)
  selLayout: true,      // v2: layout correlation enters the selection
  selAcceptBonus: 0.2,  // v2: bonus for candidates whose final confidence reaches acceptScore
  orient: true,
  layoutW: 0.2,
  acceptScore: 0.5,     // found when score + layoutW*(layout corr - 0.5) reaches this
  // ---- v2 scan-box mode (mode: 'box', or a prior with weight > 0) ----
  mode: 'free',         // 'free' (hand-held, anywhere) | 'box' (fixed camera over a scan box)
  prior: null,          // {center:[x,y] work px, angle: deg (card-up vs image-up, clockwise), scaleRange:[lo,hi] card short side / min(w,h), weight}
  priorAngTol: 10,      // deg: only lines this close to the prior's card axes form quads
  priorCenterTol: 0.16, // max centre offset from prior.center, fraction of min(w,h)
  priorInnerSlack: 0.94, // scaleRange[0] x this: an inner-frame quad passes a prior learned from outer edges
  anchor: true,         // box mode: locate the card from its inner frame + border geometry (black border on black box)
  borderMM: [2.5, 2.5, 6.2, 2.5], // outer edge -> inner frame (top,right,bottom,left), modern black-border frame
  anchorDark: 95,       // box mode: max brightness (max RGB) of the border band just outside the frame step
  anchorSearch: [-12, 8], // mm range (relative to the chosen quad side, + outward) searched for the frame step
  anchorMinSides: 3,
  anchorEdge: null,     // e.g. [0.9, 1.6]: search the real edge this far (mm) around the border model (sides, extra inward for the bottom); tried, no gain on sim or real -> off
  anchorEdgeMin: 10,
  priorQuadMinSides: 0, // box mode: with fewer anchored sides, fall back to prior.quad (last capture) ...
  priorQuadTol: 0.12,   // ... when the chosen quad is this close to it (centre / width, fraction of card width)
  anchorFree: false,    // v2 experiment: anchor in free mode on a dark surround (+14 black-on-black, -26 white border/sleeves on synthetic)
  darkSurroundMax: 60,
  // free mode, black border on a dark surround (scan box): the visible quad is often the inner frame
  // (outer edge black on black) or the platform ring around the card. The frame anchor (inner frame
  // step + border model) replaces it when that outline has a dark outside on outerDark+ sides and the
  // edge-fitted outline is more than outerAgree (fraction of card width) away from it.
  outerEdge: true,
  outerMinSides: 4,
  outerDark: 3,
  outerDarkMax: 100,   // max brightness (max RGB) of a 'dark' outside band (grey box walls ~45-110, cloth 117+)
  outerAgree: 0.025,
  outerAlt: 6,          // larger hypotheses tried when the chosen quad has no anchored outline (0 = off)
  outerAccept: 0.4,     // found bar for an anchored outline (the anchor + dark surround are evidence too)
  outerRefine: true,    // refine(): re-check the anchor at full resolution
  outerRefineTol: 0.06, // refine(): full-res anchor must lie this close to the rough corners
  boxAccept: 0.33,      // box mode: confidence bar (the prior + frame anchor already constrain the quad)
  boxOrientConf: 0.6,   // box mode: the classifier overrides the prior's up direction only above this |score| (median 1)
  orientModel: 'v2',    // 'v2' trained classifier | 'template' (v1 layout correlation)
  // free mode, half-resolution gradient (k = 2, frames > 200,000 px such as the 480x853 work frame): when the
  // result's confidence is below fullResRetry, detect again at full resolution (k = 1) and take that outline when
  // it is found and encloses the half-resolution one (area > fullResGrow x, containing its centre), or when the
  // half-resolution pass found nothing (0.7.0-beta.5). Why: at k = 2 the outer edge of a card on a light, unevenly
  // lit table breaks into short lines and an inner line (inner frame, type-line edge) wins; at k = 1 the card edge
  // is found. k = 1 alone is no fix: it lands on the inner frame of black-bordered cards on a stack, where k = 2
  // finds the edge (recordings: every k=1-larger disagreement was the card, every k=1-smaller one an inner box),
  // and on textured cloth. All k=1-larger disagreements had confidence < 0.9 at k = 2; the retry runs on ~30-55 %
  // of frames with an outline (k = 1 costs ~2.3x a k = 2 pass). 0 = off.
  fullResRetry: 0.9,
  fullResGrow: 1.04,
});

// ---------------------------------------------------------------------------
// 1. gradient

function gradientField(img, k) {
  // box-downsample by integer k into luma + one opponent chroma plane (R-B)
  const W0 = img.w, d = img.d, w = Math.floor(img.w / k), h = Math.floor(img.h / k), n = w * h;
  const B = buffers(n);
  const L = B.L, C = B.C;
  if (k === 1) {
    for (let j = 0, i = 0; j < n; j++, i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; L[j] = 0.299 * r + 0.587 * g + 0.114 * b; C[j] = (r - b) * 0.7; }
  } else if (k === 2) {
    const row = W0 * 4;
    for (let y = 0; y < h; y++) {
      let i = y * 2 * row, j = y * w;
      for (let x = 0; x < w; x++, i += 8, j++) {
        const r = d[i] + d[i + 4] + d[i + row] + d[i + row + 4], g = d[i + 1] + d[i + 5] + d[i + row + 1] + d[i + row + 5], b = d[i + 2] + d[i + 6] + d[i + row + 2] + d[i + row + 6];
        L[j] = (0.299 * r + 0.587 * g + 0.114 * b) * 0.25;
        C[j] = (r - b) * 0.175;
      }
    }
  } else {
    const inv = 1 / (k * k);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let yy = 0; yy < k; yy++) {
        let i = ((y * k + yy) * W0 + x * k) * 4;
        for (let xx = 0; xx < k; xx++, i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      }
      const j = y * w + x;
      L[j] = (0.299 * r + 0.587 * g + 0.114 * b) * inv;
      C[j] = (r - b) * 0.7 * inv;
    }
  }
  const t = B.t;
  blur121(L, t, w, h); blur121(C, t, w, h);
  const gx = B.gx, gy = B.gy, mag = B.mag;
  gx.fill(0); gy.fill(0); mag.fill(0);
  for (let y = 1; y < h - 1; y++) {
    let i = y * w;
    for (let x = 1; x < w - 1; x++) {
      i++;
      const a0 = L[i - w - 1], a1 = L[i - w], a2 = L[i - w + 1], a3 = L[i - 1], a5 = L[i + 1], a6 = L[i + w - 1], a7 = L[i + w], a8 = L[i + w + 1];
      let lx = (a2 + 2 * a5 + a8 - a0 - 2 * a3 - a6) * 0.125;
      let ly = (a6 + 2 * a7 + a8 - a0 - 2 * a1 - a2) * 0.125;
      let ml = lx * lx + ly * ly;
      const c0 = C[i - w - 1], c1 = C[i - w], c2 = C[i - w + 1], c3 = C[i - 1], c5 = C[i + 1], c6 = C[i + w - 1], c7 = C[i + w], c8 = C[i + w + 1];
      const cx = (c2 + 2 * c5 + c8 - c0 - 2 * c3 - c6) * 0.125;
      const cy = (c6 + 2 * c7 + c8 - c0 - 2 * c1 - c2) * 0.125;
      const mc = cx * cx + cy * cy;
      if (mc > ml) { const s = cx * lx + cy * ly < 0 ? -1 : 1; lx = s * cx; ly = s * cy; ml = mc; }
      gx[i] = lx; gy[i] = ly; mag[i] = Math.sqrt(ml);
    }
  }
  // non-maximum suppression along the gradient (thin edges for the segment growing)
  const nms = B.nms;
  nms.fill(0);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, m = mag[i];
    if (m < 1) continue;
    const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
    let o;
    if (ay < 0.4142 * ax) o = 1;
    else if (ax < 0.4142 * ay) o = w;
    else o = (gx[i] > 0) === (gy[i] > 0) ? w + 1 : w - 1;
    if (m >= mag[i - o] && m > mag[i + o]) nms[i] = 1;
  }
  return { w, h, k, gx, gy, mag, nms };
}

// per-size scratch buffers (detect() runs every frame at the same size; avoids ~3 MB of garbage per frame).
// The gradient field returned by gradientField() is only valid until the next detect() call.
let _buf = null;
function buffers(n) {
  if (!_buf || _buf.n !== n) {
    _buf = { n, L: new Float32Array(n), C: new Float32Array(n), t: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n),
      mag: new Float32Array(n), nms: new Uint8Array(n), used: new Uint8Array(n), reg: new Int32Array(Math.min(n, 65536)) };
  }
  return _buf;
}

function blur121(a, t, w, h) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    t[r] = a[r]; t[r + w - 1] = a[r + w - 1];
    for (let x = 1; x < w - 1; x++) t[r + x] = (a[r + x - 1] + 2 * a[r + x] + a[r + x + 1]) * 0.25;
  }
  for (let x = 0; x < w; x++) { a[x] = t[x]; a[(h - 1) * w + x] = t[(h - 1) * w + x]; }
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) a[r + x] = (t[r + x - w] + 2 * t[r + x] + t[r + x + w]) * 0.25;
  }
}

function noiseLevel(mag, w, h) {
  // median gradient magnitude over a sparse grid (flat regions dominate)
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) { hist[Math.min(255, (mag[y * w + x] * 4) | 0)]++; n++; }
  let c = 0;
  for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= n / 2) return (i + 0.5) / 4; }
  return 64;
}

// ---------------------------------------------------------------------------
// 2. LSD-like segments

function segments(G, P) {
  const { w, h, gx, gy, mag, nms } = G, n = w * h;
  const noise = noiseLevel(mag, w, h);
  const T = Math.max(1.6, 2.2 * noise);
  let mx = 0;
  for (let i = 0; i < n; i++) if (mag[i] > mx) mx = mag[i];
  // pseudo-sort by magnitude (descending) with 512 bins
  const NB = 512, cnt = new Uint32Array(NB + 1), k = (NB - 1) / Math.max(1e-6, mx - T);
  let m = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, v = mag[i]; if (nms[i] && v >= T) { cnt[NB - 1 - ((v - T) * k | 0)]++; m++; } }
  const off = new Uint32Array(NB + 1);
  for (let b = 0; b < NB; b++) off[b + 1] = off[b] + cnt[b];
  const order = new Int32Array(m), pos = off.slice(0, NB);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, v = mag[i]; if (nms[i] && v >= T) order[pos[NB - 1 - ((v - T) * k | 0)]++] = i; }

  const B = buffers(n), used = B.used, reg = B.reg;
  used.fill(0);
  const cosTol = Math.cos(P.tolDeg * Math.PI / 180);
  const segs = [];
  for (let oi = 0; oi < m; oi++) {
    const s = order[oi];
    if (used[s]) continue;
    used[s] = 1;
    let ms = mag[s], dx = gx[s] / ms, dy = gy[s] / ms, sx = dx, sy = dy;
    let len = 0;
    reg[len++] = s;
    for (let r = 0; r < len; r++) {
      const p = reg[r], px = p % w, py = (p / w) | 0;
      if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const q = p + oy * w + ox;
        if (used[q]) continue;
        const mq = mag[q];
        if (mq < T || !nms[q]) continue;
        const ux = gx[q] / mq, uy = gy[q] / mq, dt = ux * dx + uy * dy;
        if (dt >= cosTol || -dt >= cosTol) {
          used[q] = 1;
          if (len < reg.length) reg[len++] = q;
          if (dt >= 0) { sx += ux; sy += uy; } else { sx -= ux; sy -= uy; }
          const l = hyp2(sx, sy); dx = sx / l; dy = sy / l;
        }
      }
    }
    if (len < P.minSegLen) continue;
    // weighted PCA line fit
    let W = 0, cx = 0, cy = 0;
    for (let r = 0; r < len; r++) { const p = reg[r], wt = mag[p]; W += wt; cx += wt * (p % w); cy += wt * ((p / w) | 0); }
    cx /= W; cy /= W;
    // direction along the segment = perpendicular to the mean gradient
    let ax = -dy, ay = dx;
    let t0 = Infinity, t1 = -Infinity, e2 = 0;
    for (let r = 0; r < len; r++) {
      const p = reg[r], X = (p % w) - cx, Y = ((p / w) | 0) - cy, t = X * ax + Y * ay, e = X * dx + Y * dy;
      if (t < t0) t0 = t; if (t > t1) t1 = t;
      e2 += mag[p] * e * e;
    }
    const L = t1 - t0;
    if (L < P.minSegLen) continue;
    // TLS refit of the direction (more precise than the mean gradient)
    let sxx = 0, syy = 0, sxy = 0;
    for (let r = 0; r < len; r++) { const p = reg[r], wt = mag[p], X = (p % w) - cx, Y = ((p / w) | 0) - cy; sxx += wt * X * X; syy += wt * Y * Y; sxy += wt * X * Y; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let bx = Math.cos(th), by = Math.sin(th);
    if (bx * ax + by * ay < 0) { bx = -bx; by = -by; }
    const rms = Math.sqrt(e2 / W);
    if (rms > 1.0 || len / L < 0.6) continue;
    // recompute extents with the refined direction
    t0 = Infinity; t1 = -Infinity;
    for (let r = 0; r < len; r++) { const p = reg[r], t = ((p % w) - cx) * bx + (((p / w) | 0) - cy) * by; if (t < t0) t0 = t; if (t > t1) t1 = t; }
    let strength = 0;
    for (let r = 0; r < len; r++) strength += mag[reg[r]];
    segs.push({ cx, cy, dx: bx, dy: by, a: [cx + bx * t0, cy + by * t0], b: [cx + bx * t1, cy + by * t1], len: t1 - t0, mean: strength / len, pol: dx * -by + dy * bx });
  }
  return { segs, T, noise };
}

// ---------------------------------------------------------------------------
// 3. merge collinear segments into lines

function mergeLines(segs, P, w, h) {
  segs.sort((a, b) => b.len - a.len);
  const lines = [];
  const cosA = Math.cos(2.5 * Math.PI / 180);
  for (const s of segs) {
    let best = null, bd = Infinity;
    for (const L of lines) {
      if (Math.abs(L.dx * s.dx + L.dy * s.dy) < cosA) continue;
      const da = Math.abs(L.nx * s.a[0] + L.ny * s.a[1] - L.c), db = Math.abs(L.nx * s.b[0] + L.ny * s.b[1] - L.c);
      const tol = 1.2 + 0.004 * L.len;
      if (da < tol && db < tol && da + db < bd) { bd = da + db; best = L; }
    }
    if (best) {
      best.segs.push(s);
      fitLine(best);
    } else {
      const L = { segs: [s] };
      fitLine(L);
      lines.push(L);
    }
  }
  for (const L of lines) {
    // covered intervals along the line direction
    const iv = L.segs.map((s) => { const ta = L.dx * s.a[0] + L.dy * s.a[1], tb = L.dx * s.b[0] + L.dy * s.b[1]; return ta < tb ? [ta, tb] : [tb, ta]; })
      .sort((a, b) => a[0] - b[0]);
    const u = [];
    for (const v of iv) { if (u.length && v[0] <= u[u.length - 1][1] + 1.5) u[u.length - 1][1] = Math.max(u[u.length - 1][1], v[1]); else u.push([...v]); }
    L.iv = u;
    L.cover = u.reduce((s, v) => s + v[1] - v[0], 0);
    L.strength = L.segs.reduce((s, g) => s + g.len * g.mean, 0) / Math.max(1, L.segs.reduce((s, g) => s + g.len, 0));
  }
  lines.sort((a, b) => b.cover - a.cover);
  return lines.slice(0, P.maxLines);
}

function fitLine(L) {
  // TLS over segment endpoints, weighted by segment length
  let W = 0, mx = 0, my = 0;
  for (const s of L.segs) { W += 2 * s.len; mx += s.len * (s.a[0] + s.b[0]); my += s.len * (s.a[1] + s.b[1]); }
  mx /= W; my /= W;
  let sxx = 0, syy = 0, sxy = 0;
  for (const s of L.segs) for (const p of [s.a, s.b]) { const X = p[0] - mx, Y = p[1] - my; sxx += s.len * X * X; syy += s.len * Y * Y; sxy += s.len * X * Y; }
  if (L.segs.length === 1) { const s = L.segs[0]; L.dx = s.dx; L.dy = s.dy; }
  else { const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); L.dx = Math.cos(th); L.dy = Math.sin(th); }
  L.nx = -L.dy; L.ny = L.dx; L.c = L.nx * mx + L.ny * my; L.mx = mx; L.my = my;
  L.len = L.segs.reduce((s, g) => s + g.len, 0);
}

// ---------------------------------------------------------------------------
// geometry helpers

function intersectL(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(a.c * b.ny - a.ny * b.c) / det, (a.nx * b.c - a.c * b.nx) / det];
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Width/height ratio of the planar rectangle imaged as quad q (TL,TR,BR,BL), Zhang & He 2007. */
export function rectAspect(q, f, u0, v0) {
  // scalar form (no temporaries: called for every hypothesis that passes the coverage tests)
  const m1x = q[0][0], m1y = q[0][1], m2x = q[1][0], m2y = q[1][1], m3x = q[3][0], m3y = q[3][1], m4x = q[2][0], m4y = q[2][1];
  // c14 = m1 x m4 (homogeneous, z = 1)
  const c14x = m1y - m4y, c14y = m4x - m1x, c14z = m1x * m4y - m1y * m4x;
  const c24x = m2y - m4y, c24y = m4x - m2x, c24z = m2x * m4y - m2y * m4x;
  const c34x = m3y - m4y, c34y = m4x - m3x, c34z = m3x * m4y - m3y * m4x;
  const k2 = (c14x * m3x + c14y * m3y + c14z) / (c24x * m3x + c24y * m3y + c24z);
  const k3 = (c14x * m2x + c14y * m2y + c14z) / (c34x * m2x + c34y * m2y + c34z);
  const n2x = k2 * m2x - m1x, n2y = k2 * m2y - m1y, n2z = k2 - 1, n3x = k3 * m3x - m1x, n3y = k3 * m3y - m1y, n3z = k3 - 1;
  const ff = f * f;
  const a2 = n2x - u0 * n2z, b2 = n2y - v0 * n2z, a3 = n3x - u0 * n3z, b3 = n3y - v0 * n3z;
  const r = Math.sqrt(((a2 * a2 + b2 * b2) / ff + n2z * n2z) / ((a3 * a3 + b3 * b3) / ff + n3z * n3z));
  if (Number.isFinite(r) && r > 0) return r;
  const len = (a, b) => hyp2(a[0] - b[0], a[1] - b[1]);
  return (len(q[0], q[1]) + len(q[3], q[2])) / (len(q[0], q[3]) + len(q[1], q[2]));
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) & 3]; a += p[0] * r[1] - r[0] * p[1]; }
  return a / 2;
}

function convex(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) & 3], c = q[(i + 2) & 3];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z === 0) return 0;
    if (s === 0) s = Math.sign(z); else if (Math.sign(z) !== s) return 0;
  }
  return s;
}

function pointInQuad(p, q, tol = 0) {
  // q clockwise (positive area in y-down coords)
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) & 3], ex = b[0] - a[0], ey = b[1] - a[1], l = hyp2(ex, ey);
    if ((ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / l < -tol) return false;
  }
  return true;
}

function solve8(A, b) {
  const n = 8, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

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

const applyH = (H, x, y) => { const z = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]; };

// ---------------------------------------------------------------------------
// 4. quad hypotheses

function angDiffMod180(a, b) { // radians, inputs are unit direction vectors
  const c = Math.abs(a.dx * b.dx + a.dy * b.dy);
  return Math.acos(Math.min(1, c));
}

function sideCov(L, a, b) {
  // fraction of the side a->b (inner 8..92%) covered by line L's intervals (no allocation)
  const ta = L.dx * a[0] + L.dy * a[1], tb = L.dx * b[0] + L.dy * b[1];
  let lo = ta < tb ? ta : tb, hi = ta < tb ? tb : ta;
  const len = hi - lo;
  lo += 0.08 * len; hi -= 0.08 * len;
  let c = 0;
  const iv = L.iv;
  for (let i = 0; i < iv.length; i++) { const v = iv[i], x0 = v[0] > lo ? v[0] : lo, x1 = v[1] < hi ? v[1] : hi; if (x1 > x0) c += x1 - x0; }
  return c / Math.max(1e-6, hi - lo);
}

function sideCoverage(L, a, b) {
  // fraction of the side a->b (inner 8..92%) covered by line L's intervals
  const ta = L.dx * a[0] + L.dy * a[1], tb = L.dx * b[0] + L.dy * b[1];
  let lo = Math.min(ta, tb), hi = Math.max(ta, tb);
  const len = hi - lo;
  lo += 0.08 * len; hi -= 0.08 * len;
  let c = 0;
  for (const v of L.iv) { const x0 = Math.max(lo, v[0]), x1 = Math.min(hi, v[1]); if (x1 > x0) c += x1 - x0; }
  // overshoot: line support well beyond the corners (a long straight background edge)
  let over = 0;
  const olo = Math.min(ta, tb) - 0.15 * len, ohi = Math.max(ta, tb) + 0.15 * len;
  for (const v of L.iv) { if (v[0] < olo) over += Math.min(olo, v[1]) - v[0]; if (v[1] > ohi) over += v[1] - Math.max(ohi, v[0]); }
  return { cov: c / Math.max(1e-6, hi - lo), over: over / len };
}

function hypotheses(lines, w, h, P) {
  const n = lines.length, minSide = P.minSideRel * Math.min(w, h);
  const cosOpp = Math.cos(P.oppDeg * Math.PI / 180);
  lines.forEach((L, i) => { L.id = i; });
  // intersection table (null = parallel-ish or outside the frame)
  const X = new Array(n * n).fill(null);
  const sinMin = Math.sin(25 * Math.PI / 180);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = lines[i], b = lines[j];
    if (Math.abs(a.dx * b.dy - a.dy * b.dx) < sinMin) continue;
    const p = intersectL(a, b);
    if (!p || p[0] < -0.5 || p[1] < -0.5 || p[0] > w + 0.5 || p[1] > h + 0.5) continue;
    X[i * n + j] = X[j * n + i] = p;
  }
  // coverage cache for (line, corner pair)
  // typed-array cache (Map lookups dominated the pair-of-pairs loop)
  const covC = new Float32Array(n * n * n).fill(-1), ovC = new Float32Array(n * n * n).fill(-1);
  const cover = (L, o1, o2) => {
    const key = (L.id * n + Math.min(o1.id, o2.id)) * n + Math.max(o1.id, o2.id);
    if (covC[key] < 0) covC[key] = sideCov(L, X[L.id * n + o1.id], X[L.id * n + o2.id]);
    return key;
  };
  const overOf = (key, L, o1, o2) => {
    if (ovC[key] < 0) ovC[key] = sideCoverage(L, X[L.id * n + o1.id], X[L.id * n + o2.id]).over;
    return ovC[key];
  };
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = lines[i], b = lines[j];
    if (Math.abs(a.dx * b.dx + a.dy * b.dy) < cosOpp) continue;
    const s1 = Math.abs(a.nx * b.mx + a.ny * b.my - a.c), s2 = Math.abs(b.nx * a.mx + b.ny * a.my - b.c);
    if (Math.min(s1, s2) < minSide) continue;
    let dx = a.dx, dy = a.dy;
    if (a.dx * b.dx + a.dy * b.dy < 0) { dx += -b.dx; dy += -b.dy; } else { dx += b.dx; dy += b.dy; }
    const l = hyp2(dx, dy);
    pairs.push({ a, b, dx: dx / l, dy: dy / l });
  }
  const sinCorner = Math.sin(P.cornerDeg * Math.PI / 180);
  const f = P.focalRel * Math.max(w, h), u0 = w / 2, v0 = h / 2;
  const out = [];
  // pair index + per-pair list of cross lines (lines that intersect both lines of the pair inside the
  // frame and are covered between them): the partner pair must consist of two such lines
  const pairIdx = new Int32Array(n * n).fill(-1);
  pairs.forEach((A, i) => { pairIdx[A.a.id * n + A.b.id] = i; pairIdx[A.b.id * n + A.a.id] = i; });
  const NP = pairs.length, mark = new Uint8Array(NP * n), crossL = new Int32Array(NP * n), crossN = new Int32Array(NP);
  for (let i = 0; i < NP; i++) {
    const A = pairs[i], ai = A.a.id, bi = A.b.id;
    let nc = 0;
    for (let c = 0; c < n; c++) {
      if (c === ai || c === bi || !X[ai * n + c] || !X[bi * n + c]) continue;
      if (covC[cover(lines[c], A.a, A.b)] < 0.12) continue;
      crossL[i * n + nc++] = c; mark[i * n + c] = 1;
    }
    crossN[i] = nc;
  }
  for (let i = 0; i < NP; i++) {
    const A = pairs[i], ai = A.a.id, bi = A.b.id, nc = crossN[i], base = i * n;
    for (let u = 0; u < nc; u++) for (let v = u + 1; v < nc; v++) {
      const j = pairIdx[crossL[base + u] * n + crossL[base + v]];
      if (j <= i) continue;
      // both lines of A must cross B (inside the frame, covered between B's lines): precomputed marks
      if (!mark[j * n + ai] || !mark[j * n + bi]) continue;
      const B = pairs[j], ci = B.a.id, di = B.b.id;
      if (Math.abs(A.dx * B.dy - A.dy * B.dx) < sinCorner) continue;
      const p0 = X[ai * n + ci], p1 = X[ai * n + di];
      if (!p0 || !p1) continue;
      const k0 = cover(A.a, B.a, B.b), c0v = covC[k0];
      if (c0v < 0.12) continue;
      const p2 = X[bi * n + di], p3 = X[bi * n + ci];
      if (!p2 || !p3) continue;
      const k2 = cover(A.b, B.a, B.b), c2v = covC[k2];
      if (c2v < 0.12) continue;
      const k1 = cover(B.b, A.a, A.b), c1v = covC[k1];
      if (c1v < 0.12) continue;
      const k3 = cover(B.a, A.a, A.b), c3v = covC[k3];
      if (c3v < 0.12) continue;
      const cs = c0v + c1v + c2v + c3v;
      if (cs < 1.6) continue;
      const c0 = { cov: c0v, over: 0 }, c1 = { cov: c1v, over: 0 }, c2 = { cov: c2v, over: 0 }, c3 = { cov: c3v, over: 0 };
      let q = [p0, p1, p2, p3], sl = [A.a, B.b, A.b, B.a], cov = [c0.cov, c1.cov, c2.cov, c3.cov];
      const cv = convex(q);
      if (!cv) continue;
      if (cv < 0) { q = [q[0], q[3], q[2], q[1]]; sl = [sl[3], sl[2], sl[1], sl[0]]; cov = [cov[3], cov[2], cov[1], cov[0]]; }
      let minL = Infinity;
      for (let k = 0; k < 4; k++) minL = Math.min(minL, hyp2(q[k][0] - q[(k + 1) & 3][0], q[k][1] - q[(k + 1) & 3][1]));
      if (minL < minSide) continue;
      let angOk = true;
      for (let k = 0; k < 4; k++) {
        const a = q[(k + 3) & 3], b = q[k], c = q[(k + 1) & 3];
        const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
        const dt = ux * vx + uy * vy;
        if (dt * dt > 0.64 * (ux * ux + uy * uy) * (vx * vx + vy * vy)) { angOk = false; break; } // 37..143 deg
      }
      if (!angOk) continue;
      const asp = rectAspect(q, f, u0, v0), r = asp < 1 ? asp : 1 / asp, dev = Math.abs(r - CARD_R) / CARD_R;
      if (dev > P.aspectTol) continue;
      const cmin = Math.min(c0.cov, c1.cov, c2.cov, c3.cov);
      const over = overOf(k0, A.a, B.a, B.b) + overOf(k1, B.b, A.a, A.b) + overOf(k2, A.b, B.a, B.b) + overOf(k3, B.a, A.a, A.b);
      const quick = cs / 4 + 0.25 * cmin - 0.08 * over - 0.6 * dev;
      out.push({ q, sl, asp, dev, cov, quick, area: quadArea(q) });
    }
  }
  out.sort((a, b) => b.quick - a.quick);
  out.nPairs = pairs.length;
  return out;
}

/** Top hypotheses with diversity: at most perCluster per (centre, size) cluster. */
function diverse(hyp, max, perCluster) {
  const sel = [];
  for (const c of hyp) {
    if (sel.length >= max) break;
    const cx = (c.q[0][0] + c.q[2][0]) / 2, cy = (c.q[0][1] + c.q[2][1]) / 2, r = Math.sqrt(c.area);
    c.cx = cx; c.cy = cy;
    let same = 0;
    for (const s of sel) if (hyp2(s.cx - cx, s.cy - cy) < 0.25 * r && s.area / c.area > 0.6 && s.area / c.area < 1.67) same++;
    if (same < perCluster) sel.push(c);
  }
  return sel;
}

// ---------------------------------------------------------------------------
// 5. pixel scoring

function edgeSupport(G, a, b, T) {
  // fraction of points along a->b (8..92%) with an aligned gradient within +-1.5 px
  const { w, h, gx, gy, mag } = G;
  const ex = b[0] - a[0], ey = b[1] - a[1], len = hyp2(ex, ey), dx = ex / len, dy = ey / len, nx = -dy, ny = dx;
  const N = Math.max(12, Math.min(48, Math.round(len / 3)));
  let hit = 0, sum = 0;
  for (let k = 0; k < N; k++) {
    const t = 0.08 + 0.84 * k / (N - 1), px = a[0] + ex * t, py = a[1] + ey * t;
    let best = 0;
    for (let s = -2; s <= 2; s++) {
      const x = Math.round(px + nx * s * 0.75), y = Math.round(py + ny * s * 0.75);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x, m = mag[i];
      if (m < T) continue;
      const al = Math.abs(gx[i] * nx + gy[i] * ny) / m;
      if (al > 0.93 && m > best) best = m;
    }
    if (best > 0) { hit++; sum += best; }
  }
  return { frac: hit / N, mean: hit ? sum / hit : 0 };
}

function ringStats(img, q, inset) {
  // mean RGB in a thin ring just inside (inset>0) or outside (inset<0) each side
  const { w, h, d } = img;
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const res = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) & 3];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = hyp2(ex, ey);
    let nx = -ey / len, ny = ex / len;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) { nx = -nx; ny = -ny; } // inward
    let r = 0, g = 0, bb = 0, c = 0;
    for (let t = 0.12; t <= 0.88; t += 0.04) {
      const x = Math.round(a[0] + ex * t + nx * inset - 0.5), y = Math.round(a[1] + ey * t + ny * inset - 0.5);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      r += d[i]; g += d[i + 1]; bb += d[i + 2]; c++;
    }
    res.push(c ? [r / c, g / c, bb / c] : [0, 0, 0]);
  }
  return res;
}

function ringSpread(rs) {
  let m = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) m = Math.max(m, hyp3(rs[i][0] - rs[j][0], rs[i][1] - rs[j][1], rs[i][2] - rs[j][2]));
  return m;
}

function extSupport(G, a, b, T) {
  // aligned-edge support on the extension of side a->b beyond b (6..30% of the side length)
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const p0 = [b[0] + ex * 0.06, b[1] + ey * 0.06], p1 = [b[0] + ex * 0.3, b[1] + ey * 0.3];
  if (p1[0] < 1 || p1[1] < 1 || p1[0] > G.w - 2 || p1[1] > G.h - 2) {
    // clip to the frame; outside counts as no support
    const t = clipT(b, [ex, ey], G.w, G.h);
    if (t < 0.12) return 0;
    p1[0] = b[0] + ex * Math.min(0.3, t); p1[1] = b[1] + ey * Math.min(0.3, t);
  }
  const e = edgeSupport(G, [p0[0] - (p1[0] - p0[0]) * 0.087, p0[1] - (p1[1] - p0[1]) * 0.087], [p1[0] + (p1[0] - p0[0]) * 0.087, p1[1] + (p1[1] - p0[1]) * 0.087], T);
  return e.frac;
}

function clipT(p, d, w, h) {
  let t = Infinity;
  if (d[0] > 0) t = Math.min(t, (w - 2 - p[0]) / d[0]); else if (d[0] < 0) t = Math.min(t, (1 - p[0]) / d[0]);
  if (d[1] > 0) t = Math.min(t, (h - 2 - p[1]) / d[1]); else if (d[1] < 0) t = Math.min(t, (1 - p[1]) / d[1]);
  return t;
}

function scoreCand(c, G, img, T, P) {
  const ext = [];
  for (let k = 0; k < 4; k++) {
    const a = c.q[k], b = c.q[(k + 1) & 3];
    ext.push(extSupport(G, a, b, T), extSupport(G, b, a, T));
  }
  c.ext = ext;
  const es = [...ext].sort((x, y) => y - x);
  c.extPen = (es[0] + es[1]) / 2;
  const sup = [];
  let s = 0, smin = 1;
  for (let k = 0; k < 4; k++) { const e = edgeSupport(G, c.q[k], c.q[(k + 1) & 3], T); sup.push(e.frac); s += e.frac; smin = Math.min(smin, e.frac); }
  const side = Math.sqrt(Math.abs(c.area));
  const k = G.k, qi = c.q.map(([x, y]) => [x * k + (k - 1) / 2 + 0.5, y * k + (k - 1) / 2 + 0.5]);
  const inner = ringSpread(ringStats(img, qi, Math.max(1.2, 0.02 * side * k)));
  c.sup = sup;
  c.inner = inner;
  // edge support dominates; a consistent inner border ring (black/white border) helps
  c.score = 0.75 * (s / 4) + 0.25 * smin - P.devW * c.dev - P.extW * c.extPen - 0.15 * Math.min(1, inner / 120) + 0.05 * (c.quick);
  return c;
}

// ---------------------------------------------------------------------------
// 6. refinement (shared by detect at analysis resolution and refine at full res)

function lumAt(img, x, y) {
  // bilinear luma; x,y in pixel-index coordinates (centre of pixel i = i)
  const { w, h, d } = img;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
  const l00 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const l10 = 0.299 * d[i + 4] + 0.587 * d[i + 5] + 0.114 * d[i + 6];
  const l01 = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  const l11 = 0.299 * d[j + 4] + 0.587 * d[j + 5] + 0.114 * d[j + 6];
  return (l00 * (1 - fx) + l10 * fx) * (1 - fy) + (l01 * (1 - fx) + l11 * fx) * fy;
}

function rgbAt(img, x, y, out) {
  const { w, h, d } = img;
  const xi = Math.max(0, Math.min(w - 1, Math.round(x))), yi = Math.max(0, Math.min(h - 1, Math.round(y))), i = (yi * w + xi) * 4;
  out[0] = d[i]; out[1] = d[i + 1]; out[2] = d[i + 2];
}

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

function ransacLine(pts, tol, iters = 120) {
  if (pts.length < 5) return null;
  const rnd = lcg(pts.length * 2654435761);
  let best = null;
  for (let it = 0; it < iters; it++) {
    const a = pts[(rnd() * pts.length) | 0], b = pts[(rnd() * pts.length) | 0];
    if (a === b) continue;
    let nx = b[1] - a[1], ny = a[0] - b[0];
    const L = hyp2(nx, ny);
    if (L < 1e-6) continue;
    nx /= L; ny /= L;
    const c = nx * a[0] + ny * a[1];
    let cnt = 0;
    for (const p of pts) if (Math.abs(nx * p[0] + ny * p[1] - c) < tol) cnt += p[2];
    if (!best || cnt > best.cnt) best = { nx, ny, c, cnt };
  }
  if (!best) return null;
  return tlsFit(pts.filter((p) => Math.abs(best.nx * p[0] + best.ny * p[1] - best.c) < tol));
}

function tlsFit(inl) {
  let W = 0, mx = 0, my = 0;
  for (const p of inl) { W += p[2]; mx += p[2] * p[0]; my += p[2] * p[1]; }
  if (!W) return null;
  mx /= W; my /= W;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of inl) { const X = p[0] - mx, Y = p[1] - my; sxx += p[2] * X * X; syy += p[2] * Y * Y; sxy += p[2] * X * Y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(th), dy = Math.sin(th);
  return { nx: -dy, ny: dx, c: -dy * mx + dx * my, n: inl.length, wsum: W, pts: inl };
}

/**
 * Per-side refinement of quad q (pixel-index coords) on RGBA img.
 * bandIn/bandOut in px; returns new quad or null.
 */
function refineQuad(img, q, { bandIn, bandOut, rays = 40, mode = 'near', polish = true, angTol = 5 } = {}) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const lines = [];
  const rgb0 = [0, 0, 0], rgb1 = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) & 3];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = hyp2(ex, ey), dx = ex / len, dy = ey / len;
    let nx = -dy, ny = dx;
    if (nx * (a[0] - cx) + ny * (a[1] - cy) < 0) { nx = -nx; ny = -ny; } // outward
    const R = Math.max(12, Math.min(rays, Math.round(len / 3)));
    const S = Math.ceil(bandIn), E = Math.ceil(bandOut), np = S + E + 1;
    const prof = new Float32Array(np + 2), gr = new Float32Array(np);
    const pts = [];
    const sp = Math.max(0.7, Math.min(2, len / 200));
    for (let r = 0; r < R; r++) {
      const t = 0.08 + 0.84 * r / (R - 1), px = a[0] + ex * t, py = a[1] + ey * t;
      for (let i = 0; i < np + 2; i++) {
        const s = i - 1 - S;
        const x = px + nx * s, y = py + ny * s;
        prof[i] = lumAt(img, x - dx * sp, y - dy * sp) + lumAt(img, x, y) + lumAt(img, x + dx * sp, y + dy * sp);
      }
      // colour difference across the edge as well (black border on a coloured mat)
      let mx = 0;
      for (let i = 0; i < np; i++) {
        const s = i - S;
        let v = Math.abs(prof[i + 2] - prof[i]) / 6;
        rgbAt(img, px + nx * (s - 1.5), py + ny * (s - 1.5), rgb0); rgbAt(img, px + nx * (s + 1.5), py + ny * (s + 1.5), rgb1);
        const cd = hyp2((rgb1[0] - rgb1[1]) - (rgb0[0] - rgb0[1]), (rgb1[0] + rgb1[1]) / 2 - rgb1[2] - ((rgb0[0] + rgb0[1]) / 2 - rgb0[2])) / 6;
        if (cd > v) v = 0.5 * (v + cd);
        gr[i] = v;
        if (v > mx) mx = v;
      }
      if (mx < 2) continue;
      for (let i = 1; i < np - 1; i++) {
        const v = gr[i];
        if (v >= 0.3 * mx && v >= gr[i - 1] && v > gr[i + 1]) {
          const den = gr[i - 1] - 2 * v + gr[i + 1], sub = den < 0 ? 0.5 * (gr[i - 1] - gr[i + 1]) / den : 0;
          const s = i - S + sub;
          pts.push([px + nx * s, py + ny * s, v / mx, s]);
        }
      }
    }
    // candidate lines: RANSAC repeatedly, keep the outermost well-supported one parallel to the side
    const cand = [];
    let rest = pts;
    for (let j = 0; j < 4; j++) {
      const L = ransacLine(rest, 1.0 + 0.004 * len);
      if (!L) break;
      if (Math.abs(L.nx * nx + L.ny * ny) > Math.cos(angTol * Math.PI / 180)) cand.push(L);
      rest = rest.filter((p) => Math.abs(L.nx * p[0] + L.ny * p[1] - L.c) >= 1.5 + 0.004 * len);
    }
    if (!cand.length) { lines.push(null); continue; }
    const top = Math.max(...cand.map((c) => c.wsum));
    const off = (L) => { const det = L.nx * nx + L.ny * ny; return (L.c - L.nx * (a[0] + ex / 2) - L.ny * (a[1] + ey / 2)) / det; };
    // mode 'near': the supported line closest to the prior side (accuracy, no re-localisation);
    // mode 'outer': the outermost well-supported one
    let good = cand.filter((c) => c.n >= 0.3 * R && (mode !== 'outer' || c.wsum >= 0.55 * top));
    if (!good.length) { lines.push(null); continue; }
    if (mode === 'outer') good.sort((x, y) => off(y) - off(x));
    else if (mode === 'near') {
      const offAt = (L, t) => { const det = L.nx * nx + L.ny * ny; return (L.c - L.nx * (a[0] + ex * t) - L.ny * (a[1] + ey * t)) / det; };
      const dn = (L) => Math.abs(offAt(L, 0.2)) + Math.abs(offAt(L, 0.8));
      good.sort((x, y) => dn(x) - dn(y));
    }
    else good.sort((x, y) => y.wsum - x.wsum);
    let L = good[0];
    if (L.n < 0.3 * R) { lines.push(null); continue; }
    lines.push(L);
  }
  if (lines.some((l) => !l)) {
    // keep the original side where a side failed
    for (let k = 0; k < 4; k++) if (!lines[k]) {
      const a = q[k], b = q[(k + 1) & 3], ex = b[0] - a[0], ey = b[1] - a[1], len = hyp2(ex, ey);
      const nx = -ey / len, ny = ex / len;
      lines[k] = { nx, ny, c: nx * a[0] + ny * a[1], keep: true };
    }
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const p = intersectL(lines[(k + 3) & 3], lines[k]);
    if (!p) return null;
    out.push(p);
  }
  if (polish) return refineQuad(img, out, { bandIn: 2.5, bandOut: 2.5, rays: 64, mode: 'best', polish: false });
  return out;
}

// ---------------------------------------------------------------------------
// outward snap: inner frame line -> outer card edge (black/white borders on similar backgrounds)

function labAt(img, x, y, out) {
  const { w, h, d } = img;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
  const r = d[i] * a + d[i + 4] * b + d[j] * c + d[j + 4] * e;
  const g = d[i + 1] * a + d[i + 5] * b + d[j + 1] * c + d[j + 5] * e;
  const bl = d[i + 2] * a + d[i + 6] * b + d[j + 2] * c + d[j + 6] * e;
  out[0] = 0.299 * r + 0.587 * g + 0.114 * bl; out[1] = (r - g) * 0.8; out[2] = ((r + g) * 0.5 - bl) * 0.8;
}

/**
 * For each side, average the colour profile across the side in card-plane mm (homography of the
 * current quad) and move the side outward to a parallel edge 1.2..7 mm outside when the band in
 * between is uniform (a card border) and that edge is significant. Iterates twice (old frames
 * have border + coloured frame). q: clockwise, pixel-index coords.
 */
function snapOutward(img, q, P) {
  let moved = 0, hiddenUsed = false;
  for (let iter = 0; iter < 2; iter++) {
    const f = P.focalRel * Math.max(img.w, img.h);
    const asp = rectAspect(q, f, img.w / 2, img.h / 2);
    const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
    if (!H) break;
    // mm per unit: side 0 (v=0) runs along u; u spans the q0->q1 side
    const uMM = asp < 1 ? 63 : 88, vMM = asp < 1 ? 88 : 63;
    const STEP = 0.25, O0 = -3, O1 = 9.5, NO = Math.round((O1 - O0) / STEP) + 1, NT = 28;
    const lab = [0, 0, 0];
    const offs = [0, 0, 0, 0], hidden = [false, false, false, false], rims = [], bands = [];
    let any = false;
    for (let k = 0; k < 4; k++) {
      const PL = new Float32Array(NO), PA = new Float32Array(NO), PB = new Float32Array(NO);
      const perT = new Float32Array(NO * NT);
      for (let oi = 0; oi < NO; oi++) {
        const o = O0 + oi * STEP;
        let sl = 0, sa = 0, sb = 0;
        for (let ti = 0; ti < NT; ti++) {
          const t = 0.12 + 0.76 * ti / (NT - 1);
          let u, v;
          if (k === 0) { u = t; v = -o / vMM; } else if (k === 1) { u = 1 + o / uMM; v = t; }
          else if (k === 2) { u = 1 - t; v = 1 + o / vMM; } else { u = -o / uMM; v = 1 - t; }
          const p = applyH(H, u, v);
          labAt(img, p[0], p[1], lab);
          sl += lab[0]; sa += lab[1]; sb += lab[2];
          perT[oi * NT + ti] = lab[0];
        }
        PL[oi] = sl / NT; PA[oi] = sa / NT; PB[oi] = sb / NT;
      }
      // edge strength profile (difference over +-0.5 mm)
      const D = 2, E = new Float32Array(NO);
      for (let oi = D; oi < NO - D; oi++) E[oi] = hyp3(PL[oi + D] - PL[oi - D], PA[oi + D] - PA[oi - D], PB[oi + D] - PB[oi - D]);
      const sorted = Array.from(E.subarray(D, NO - D)).sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      const i0 = Math.round(-O0 / STEP);
      let e0 = 0;
      for (let oi = i0 - 4; oi <= i0 + 4; oi++) e0 = Math.max(e0, E[oi]);
      // candidate outer peaks
      let pick = 0;
      const avgC = (a, b2) => { let l = 0, aa = 0, bb = 0; for (let j = a; j <= b2; j++) { l += PL[j]; aa += PA[j]; bb += PB[j]; } const n2 = b2 - a + 1; return [l / n2, aa / n2, bb / n2]; };
      const rim = avgC(i0 - Math.round(1.2 / STEP), i0 - Math.round(0.3 / STEP));
      rims[k] = rim;
      for (let oi = i0 + Math.round(1.2 / STEP); oi <= i0 + Math.round(P.snapMaxMM / STEP) && oi < NO - D - 1; oi++) {
        const e = E[oi];
        if (!(e >= E[oi - 1] && e > E[oi + 1])) continue;
        if (e < Math.max(3, P.snapRel * e0)) continue;
        const span = oi - i0, b0 = i0 + Math.max(1, Math.round(span * P.bandLo)), b1 = oi - Math.max(1, Math.round(span * P.bandLo));
        if (b1 < b0) continue;
        const o0 = oi + Math.round(0.4 / STEP), o1 = Math.min(NO - 1, oi + Math.round(1.6 / STEP));
        const band = avgC(b0, b1), outC = avgC(o0, o1);
        const contrast = hyp3(band[0] - outC[0], band[1] - outC[1], band[2] - outC[2]);
        const rimStep = hyp3(band[0] - rim[0], band[1] - rim[1], band[2] - rim[2]);
        // robust band uniformity along the side (collector text in the bottom border is allowed)
        const colMeans = new Float32Array(NT);
        for (let ti = 0; ti < NT; ti++) { let s2 = 0; for (let j = b0; j <= b1; j++) s2 += perT[j * NT + ti]; colMeans[ti] = s2 / (b1 - b0 + 1); }
        const sorted2 = Array.from(colMeans).sort((x, y) => x - y), bmed = sorted2[NT >> 1];
        let outl = 0, bs = 0, nin = 0;
        for (let ti = 0; ti < NT; ti++) { const dv = Math.abs(colMeans[ti] - bmed); if (dv > P.bandDev) outl++; else { bs += dv * dv; nin++; } }
        bs = Math.sqrt(bs / Math.max(1, nin));
        const chroma = hyp2(band[1], band[2]);
        if (contrast < P.snapContrast || rimStep < P.snapRimStep || outl > P.bandOutl * NT || bs > P.bandStd || chroma > 30) continue;
        pick = (oi - i0) * STEP;
        bands[k] = band;
        break;
      }
      if (pick) { offs[k] = pick; any = true; continue; }
      if (hiddenUsed) continue;
      // hidden border: nothing outside (flat, neutral, very dark or very bright) but a clearly
      // different, uniform rim just inside => probably the inner frame of a black/white border
      // that matches the background exactly
      let eo = 0;
      for (let oi = i0 + Math.round(1.1 / STEP); oi <= i0 + Math.round(6 / STEP) && oi < NO - D; oi++) eo = Math.max(eo, E[oi]);
      const avg = (A, a, b) => { let s2 = 0; for (let j = a; j <= b; j++) s2 += A[j]; return s2 / (b - a + 1); };
      const oa = i0 + Math.round(1 / STEP), ob = i0 + Math.round(5 / STEP), ra = i0 - Math.round(1.2 / STEP), rb = i0 - Math.round(0.3 / STEP);
      const oL = avg(PL, oa, ob), oA = avg(PA, oa, ob), oB = avg(PB, oa, ob);
      const rL = avg(PL, ra, rb), rA = avg(PA, ra, rb), rB = avg(PB, ra, rb);
      let rs = 0;
      for (let ti = 0; ti < NT; ti++) { let s2 = 0; for (let j = ra; j <= rb; j++) s2 += perT[j * NT + ti]; rs += (s2 / (rb - ra + 1) - rL) ** 2; }
      rs = Math.sqrt(rs / NT);
      const flat = eo < Math.max(3 * med, 0.12 * e0, 2.5);
      const neutral = hyp2(oA, oB) < 20 && (oL < 60 || oL > 175);
      const diff = hyp3(rL - oL, rA - oA, rB - oB);
      const rimOk = oL < 60 ? rL > oL + 20 : rL > 60 && rL < oL - 20;
      if (flat && neutral && diff > 25 && rimOk && rs < P.hiddenRimStd) hidden[k] = true;
    }
    if (!hiddenUsed && P.hiddenBorderMM > 0 && hidden.filter(Boolean).length >= P.hiddenMin) {
      for (let k = 0; k < 4; k++) if (hidden[k] && !offs[k]) { offs[k] = P.hiddenBorderMM; any = true; }
      hiddenUsed = true;
    }
    if (!any) break;
    // all-or-none: a real inner-frame -> outer-edge snap moves every side (the border runs all around);
    // a per-side subset is a sleeve margin / background band and produces hybrid outlines
    const nMoved = offs.filter((o) => o > 0).length;
    if (nMoved < P.snapMinSides) {
      // partial snap: keep a side's move only if the band it crosses looks like the card border seen
      // just inside the sides that did not move (inner-frame line -> outer edge on that side only);
      // a sleeve margin / background band has the colour of the mat, not of the border
      const still = [0, 1, 2, 3].filter((j) => !(offs[j] > 0));
      if (!still.length || !P.snapPartialTol) break;
      const rc = [0, 0, 0];
      for (const j of still) for (let c = 0; c < 3; c++) rc[c] += rims[j][c] / still.length;
      let kept = 0;
      for (let j = 0; j < 4; j++) if (offs[j] > 0) {
        const b = bands[j], dcol = hyp3(b[0] - rc[0], b[1] - rc[1], b[2] - rc[2]);
        // ...and the side's own rim must NOT look like the border (it sits on the inner frame line)
        const r = rims[j], dOwn = hyp3(r[0] - rc[0], r[1] - rc[1], r[2] - rc[2]);
        const md = P.snapPartialMode;
        // a black, neutral band with a clearly brighter rim inside = black border outside an inner frame line
        const blackBand = P.snapBlackBand && b[0] < 50 && hyp2(b[1], b[2]) < 15 && r[0] > b[0] + 30;
        const keep = md === 'own' ? dOwn > P.snapOwnTol : md === 'or' ? (dcol <= P.snapPartialTol || dOwn > P.snapOwnTol || blackBand)
          : md === 'band' ? dcol <= P.snapPartialTol : (dcol <= P.snapPartialTol && dOwn > P.snapOwnTol);
        if (!keep) offs[j] = 0; else kept++;
      }
      if (!kept) break;
    }
    // move sides outward in card-plane units and re-intersect
    const nq = [[-offs[3] / uMM, -offs[0] / vMM], [1 + offs[1] / uMM, -offs[0] / vMM], [1 + offs[1] / uMM, 1 + offs[2] / vMM], [-offs[3] / uMM, 1 + offs[2] / vMM]].map(([u, v]) => applyH(H, u, v));
    const a2 = rectAspect(nq, f, img.w / 2, img.h / 2), r2 = a2 < 1 ? a2 : 1 / a2;
    if (Math.abs(r2 - CARD_R) / CARD_R > P.aspectTol) break;
    q = nq;
    moved++;
  }
  return { q, moved };
}

// ---------------------------------------------------------------------------
// orientation

function orientation(img, q, P = DEFAULTS) {
  // q clockwise quad with q[0]->q[1] a SHORT side; flip=true if q[2] is the card's TL.
  // Rectify to 2W x 2H RGB. Card-likeness (best): correlation of the luma and gradient-magnitude layouts
  // with the frame-family templates (upright or 180). v2: the 180-degree decision comes from a trained
  // linear classifier (orientfeat.mjs + orientw.mjs: luma, gradient, text-line structure, saturation).
  const W = ORIENT_W, Hh = ORIENT_H, W2 = 2 * W, H2 = 2 * Hh;
  const H = homography([[0, 0], [W2, 0], [W2, H2], [0, H2]], q);
  if (!H) return { flip: false, conf: 0, best: 0 };
  const N2 = W2 * H2, R = new Float32Array(N2), Gc = new Float32Array(N2), B = new Float32Array(N2), big = new Float32Array(N2);
  const { w: iw, h: ih, d } = img;
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const p = applyH(H, x + 0.5, y + 0.5);
    let px = p[0] - 0.5, py = p[1] - 0.5;
    if (px < 0) px = 0; if (py < 0) py = 0; if (px > iw - 1.001) px = iw - 1.001; if (py > ih - 1.001) py = ih - 1.001;
    const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i0 = (y0 * iw + x0) * 4, j0 = i0 + iw * 4;
    const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy, i = y * W2 + x;
    R[i] = d[i0] * a + d[i0 + 4] * b + d[j0] * c + d[j0 + 4] * e;
    Gc[i] = d[i0 + 1] * a + d[i0 + 5] * b + d[j0 + 1] * c + d[j0 + 5] * e;
    B[i] = d[i0 + 2] * a + d[i0 + 6] * b + d[j0 + 2] * c + d[j0 + 6] * e;
    big[i] = 0.299 * R[i] + 0.587 * Gc[i] + 0.114 * B[i];
  }
  const n = W * Hh, v = new Float32Array(n), g = new Float32Array(n);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const i = y * W2 + x, xm = x > 0 ? i - 1 : i, xp = x < W2 - 1 ? i + 1 : i, ym = y > 0 ? i - W2 : i, yp = y < H2 - 1 ? i + W2 : i;
    const j = (y >> 1) * W + (x >> 1);
    v[j] += big[i];
    g[j] += hyp2(big[xp] - big[xm], big[yp] - big[ym]);
  }
  zscore(v); zscore(g);
  let a = -Infinity, b = -Infinity;
  for (let t = 0; t < ORIENT_TS.length; t++) {
    const T = ORIENT_TS[t], TG = ORIENT_GS[t];
    let ta = 0, tb = 0;
    for (let i = 0; i < n; i++) { ta += v[i] * T[i] + g[i] * TG[i]; tb += v[n - 1 - i] * T[i] + g[n - 1 - i] * TG[i]; }
    a = Math.max(a, ta / (2 * n)); b = Math.max(b, tb / (2 * n));
  }
  if (P.orientModel === 'template') return { flip: b > a, conf: Math.abs(a - b), best: Math.max(a, b) };
  const sc = orientScore(orientFeatures(R, Gc, B), ORIENT_W2);
  return { flip: sc < 0, conf: Math.abs(sc), best: Math.max(a, b), tmplFlip: b > a };
}

function zscore(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
  s = Math.sqrt(s / v.length) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
}


// ---------------------------------------------------------------------------
// v2 scan-box mode: prior + frame anchoring

/** Effective prior for this frame (work-frame px), or null in free mode. */
function boxPrior(P, w, h) {
  if (P.mode !== 'box' && !(P.prior && P.prior.weight > 0)) return null;
  const pr = P.prior || {};
  return {
    center: pr.center || [w / 2, h / 2],
    angle: pr.angle || 0,
    scaleRange: pr.scaleRange || [0.4, 1.02],
    weight: pr.weight != null ? pr.weight : 1,
    quad: pr.quad || null,
  };
}

/** Keep lines within tolDeg of the prior's card axes (G coordinates; directions are mod 180). */
function priorLines(lines, pr, tolDeg) {
  const a = pr.angle * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a); // card x-axis in the image
  const sinT = Math.sin(tolDeg * Math.PI / 180);
  return lines.filter((L) => {
    const c = Math.abs(L.dx * uy - L.dy * ux), s2 = Math.abs(L.dx * ux + L.dy * uy); // sin vs x-axis, sin vs y-axis
    return c < sinT || s2 < sinT;
  });
}

function priorOk(c, pr, k, w, h, P) {
  const m = Math.min(w, h);
  const cx = (c.q[0][0] + c.q[1][0] + c.q[2][0] + c.q[3][0]) / 4 * k, cy = (c.q[0][1] + c.q[1][1] + c.q[2][1] + c.q[3][1]) / 4 * k;
  c.priorDist = hyp2(cx - pr.center[0], cy - pr.center[1]) / m;
  if (c.priorDist > P.priorCenterTol) return false;
  const l = (a, b) => hyp2(a[0] - b[0], a[1] - b[1]);
  const short = Math.min(l(c.q[0], c.q[1]) + l(c.q[2], c.q[3]), l(c.q[1], c.q[2]) + l(c.q[3], c.q[0])) / 2 * k / m;
  // the low end admits the card's inner frame (~0.92 of the outline) when the prior learned outer edges
  return short >= pr.scaleRange[0] * P.priorInnerSlack && short <= pr.scaleRange[1];
}

/** Is quad a (any order, idx coords) within tol (fraction of its width) of quad b (continuous coords) - both outlines of the same card stack? */
function quadNear(a, b, tol) {
  const ca = [(a[0][0] + a[1][0] + a[2][0] + a[3][0]) / 4, (a[0][1] + a[1][1] + a[2][1] + a[3][1]) / 4];
  const cb = [(b[0][0] + b[1][0] + b[2][0] + b[3][0]) / 4 - 0.5, (b[0][1] + b[1][1] + b[2][1] + b[3][1]) / 4 - 0.5];
  const wb = cardWidthOf(b), wa = cardWidthOf(a);
  return hyp2(ca[0] - cb[0], ca[1] - cb[1]) <= tol * wb && Math.abs(wa / wb - 1) <= 2 * tol;
}

function valAt(img, x, y) {
  // bilinear max(R,G,B): a coloured frame (blue, red, green) is bright in its own channel
  const { w, h, d } = img;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * w + x0) * 4, j = i + w * 4;
  const v = (o) => Math.max(d[o], d[o + 1], d[o + 2]);
  return (v(i) * (1 - fx) + v(i + 4) * fx) * (1 - fy) + (v(j) * (1 - fx) + v(j + 4) * fx) * fy;
}

/**
 * Box mode: the card's outer edge is black on black and nearly invisible, but its inner frame (black
 * border -> coloured/light frame) is the strongest rectangle in the frame. For each side of quad q
 * (any of the nested rectangles: inner frame, card edge, ring/platform rim, wall seam) find the
 * outermost "dark band outside, bright inside" step along the side's normal, in card mm, then put
 * the card edge one border width (P.borderMM, bottom wider) outside it. The bottom side comes from
 * the layout classifier, or from the prior's up direction when the classifier is unsure.
 * Returns {q (clockwise, TL first), found sides, steps mm, orientConf, tcorr} or null.
 */
/** Number of sides of q whose outside band (0.5..4 mm) is dark and neutral (black mat / box). */
function darkSurround(img, q, P, max = P.darkSurroundMax) {
  const f = P.focalRel * Math.max(img.w, img.h);
  const asp = rectAspect(q, f, img.w / 2, img.h / 2);
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
  if (!H) return 0;
  const uMM = asp < 1 ? 63 : 88, vMM = asp < 1 ? 88 : 63;
  let n = 0;
  for (let k = 0; k < 4; k++) {
    let s = 0, c = 0;
    for (let o = 0.5; o <= 4; o += 0.5) for (let t = 0.15; t <= 0.85; t += 0.05) {
      const p = k === 0 ? applyH(H, t, -o / vMM) : k === 1 ? applyH(H, 1 + o / uMM, t) : k === 2 ? applyH(H, 1 - t, 1 + o / vMM) : applyH(H, -o / uMM, 1 - t);
      s += valAt(img, p[0], p[1]); c++;
    }
    if (s / c < max) n++;
  }
  return n;
}

/**
 * Free mode: the card outline from its inner frame + border model (frameAnchor) when that outline
 * sits on a dark surround (black border on a black box: the real edge is invisible, so line fitting
 * lands on the inner frame or on the platform ring). q: any nested outline of the card, idx coords.
 * Returns the frameAnchor result or null.
 */
function outerAnchor(img, q, P) {
  const fa = frameAnchor(img, q, P, null);
  if (!fa || !fa.q || fa.found < P.outerMinSides) return null;
  return darkSurround(img, fa.q, P, P.outerDarkMax) >= P.outerDark ? fa : null;
}

/** Worst-corner distance between two quads at their best cyclic alignment; {d, s} with b[(i+s)&3] ~ a[i]. */
function quadAlign(a, b) {
  let best = { d: Infinity, s: 0 };
  for (let s = 0; s < 4; s++) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, hyp2(a[i][0] - b[(i + s) & 3][0], a[i][1] - b[(i + s) & 3][1]));
    if (m < best.d) best = { d: m, s };
  }
  return best;
}
const quadDist = (a, b) => quadAlign(a, b).d;

function frameAnchor(img, q, P, pr) {
  const f = P.focalRel * Math.max(img.w, img.h);
  const asp = rectAspect(q, f, img.w / 2, img.h / 2);
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
  if (!H) return null;
  const uMM = asp < 1 ? 63 : 88, vMM = asp < 1 ? 88 : 63;
  const STEP = 0.25, [O0, O1] = P.anchorSearch, NO = Math.round((O1 - O0) / STEP) + 1, NT = 24;
  const at = (k, o, t) => {
    if (k === 0) return applyH(H, t, -o / vMM);
    if (k === 1) return applyH(H, 1 + o / uMM, t);
    if (k === 2) return applyH(H, 1 - t, 1 + o / vMM);
    return applyH(H, -o / uMM, 1 - t);
  };
  const steps = [null, null, null, null], strength = [0, 0, 0, 0], prof = [];
  const cs = new Float32Array(NO + 1);
  for (let k = 0; k < 4; k++) {
    const V = new Float32Array(NO);
    prof.push(V);
    for (let oi = 0; oi < NO; oi++) {
      const o = O0 + oi * STEP;
      // robust along the side: median of 3 means (glare/foil streaks hit one part of the side)
      let a = 0, b = 0, c = 0;
      for (let ti = 0; ti < NT; ti++) {
        const t = 0.14 + 0.72 * ti / (NT - 1), p = at(k, o, t), v = valAt(img, p[0], p[1]);
        if (ti < NT / 3) a += v; else if (ti < 2 * NT / 3) b += v; else c += v;
      }
      a /= NT / 3; b /= NT / 3; c /= NT / 3;
      V[oi] = a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
    }
    cs[0] = 0;
    for (let oi = 0; oi < NO; oi++) cs[oi + 1] = cs[oi] + V[oi];
    const mean = (o0, o1) => { const i0 = Math.max(0, Math.round((o0 - O0) / STEP)), i1 = Math.min(NO - 1, Math.round((o1 - O0) / STEP)); return i1 < i0 ? NaN : (cs[i1 + 1] - cs[i0]) / (i1 - i0 + 1); };
    // candidate steps from outside to inside: bright inside [o-1.2,o-0.3], dark border band outside [o+0.3,o+1.6]
    let pick = null, best = 0;
    const cands = [];
    for (let oi = NO - 1; oi >= 0; oi--) {
      const o = O0 + oi * STEP;
      if (o + 1.6 > O1 || o - 1.2 < O0) continue;
      const vin = mean(o - 1.2, o - 0.3), vout = mean(o + 0.3, o + 1.6);
      const sv = vin - vout;
      if (vout > P.anchorDark || sv < 25 || vin < 1.5 * vout) continue;
      cands.push([o, sv]);
      if (sv > best) best = sv;
    }
    // local maxima, the outermost one that is at least half as strong as the strongest
    for (let i = 0; i < cands.length; i++) {
      const [o, sv] = cands[i];
      const prev = i > 0 && cands[i - 1][0] === o + STEP ? cands[i - 1][1] : -1, next = i + 1 < cands.length && cands[i + 1][0] === o - STEP ? cands[i + 1][1] : -1;
      if (sv >= prev && sv >= next && sv >= 0.5 * best) { pick = o; strength[k] = sv; break; }
    }
    if (pick === null) continue;
    // sub-step position: steepest descent of V (inside -> outside) within +-0.75 mm
    let bo = pick, bd = -Infinity;
    for (let o = pick - 0.75; o <= pick + 0.75; o += STEP) {
      const i = Math.round((o - O0) / STEP);
      if (i < 1 || i >= NO - 1) continue;
      const dv = V[i - 1] - V[i + 1];
      if (dv > bd) { bd = dv; bo = o; }
    }
    steps[k] = bo;
  }
  const nFound = steps.filter((x) => x !== null).length;
  if (nFound < P.anchorMinSides) return { q: null, found: nFound, steps };
  // frame rectangle in q's mm frame (u along q0->q1); a missing side from the frame aspect
  const BM = P.borderMM, frameR = (63 - BM[1] - BM[3]) / (88 - BM[0] - BM[2]);
  let top = steps[0] !== null ? -steps[0] : null, right = steps[1] !== null ? uMM + steps[1] : null;
  let bot = steps[2] !== null ? vMM + steps[2] : null, left = steps[3] !== null ? -steps[3] : null;
  const longIsV = vMM > uMM, rr = longIsV ? frameR : 1 / frameR; // frame width/height in q's frame
  if (top === null) top = bot - (right - left) / rr; else if (bot === null) bot = top + (right - left) / rr;
  else if (left === null) left = right - (bot - top) * rr; else if (right === null) right = left + (bot - top) * rr;
  const toImg = (u, v) => applyH(H, u / uMM, v / vMM);
  const F = [toImg(left, top), toImg(right, top), toImg(right, bot), toImg(left, bot)];
  // which side of F is the card's bottom: layout classifier, or the prior's up direction
  const o = orderCorners(img, F, P);
  let tlIdx = F.indexOf(o.q[0]);
  if (pr && o.orientConf < P.boxOrientConf) {
    // prior: card-down direction in the image
    const a = pr.angle * Math.PI / 180, dn = [-Math.sin(a), Math.cos(a)];
    const cx = (F[0][0] + F[1][0] + F[2][0] + F[3][0]) / 4, cy = (F[0][1] + F[1][1] + F[2][1] + F[3][1]) / 4;
    // bottom side = side whose midpoint lies furthest along dn; for portrait/landscape keep the classifier's
    // long/short assignment (TL->TR is a short side), only choose between the two 180-degree variants
    const mid = (i) => [(F[i][0] + F[(i + 1) & 3][0]) / 2 - cx, (F[i][1] + F[(i + 1) & 3][1]) / 2 - cy];
    const bA = (tlIdx + 2) & 3, bB = tlIdx; // bottom side index for the classifier's choice / the flipped one
    const pA = mid(bA)[0] * dn[0] + mid(bA)[1] * dn[1], pB = mid(bB)[0] * dn[0] + mid(bB)[1] * dn[1];
    if (pB > pA) tlIdx = (tlIdx + 2) & 3;
  }
  const bottomSide = (tlIdx + 2) & 3; // side index in F/q (side i runs F[i] -> F[i+1])
  const bw = [0, 0, 0, 0]; // border per q side: card-local top/right/bottom/left
  for (let j = 0; j < 4; j++) bw[(tlIdx + j) & 3] = BM[j];
  void bottomSide;
  // card sides as outward offsets (mm) from q's sides; then a narrow search for the (faint) real edge
  const oc = [bw[0] - top, right + bw[1] - uMM, bot + bw[2] - vMM, bw[3] - left];
  const snapped = [0, 0, 0, 0];
  if (P.anchorEdge) for (let k = 0; k < 4; k++) {
    const V = prof[k], isBot = k === ((tlIdx + 2) & 3);
    const lo = oc[k] - (isBot ? P.anchorEdge[1] : P.anchorEdge[0]), hi = oc[k] + P.anchorEdge[0];
    let bo = null, bs = 0;
    const dv = [];
    for (let o = lo; o <= hi + 1e-6; o += STEP) {
      const i = Math.round((o - O0) / STEP);
      if (i < 2 || i >= NO - 2) continue;
      const d = Math.abs(V[i - 2] - V[i + 2]);
      dv.push(d);
      const vin = (V[i - 2] + V[i - 3 < 0 ? i - 2 : i - 3]) / 2;
      if (vin > P.anchorDark) continue; // inside of the edge must be the dark border
      const sc = d * (1 - 0.5 * Math.abs(o - oc[k]) / (hi - lo));
      if (sc > bs) { bs = sc; bo = o; }
    }
    if (bo === null || !dv.length) continue;
    const med = [...dv].sort((x, y) => x - y)[dv.length >> 1];
    if (bs >= P.anchorEdgeMin && bs >= 2.5 * med) { snapped[k] = bo - oc[k]; oc[k] = bo; }
  }
  const tC = -oc[0], rC = uMM + oc[1], bC = vMM + oc[2], lC = -oc[3];
  const C = [toImg(lC, tC), toImg(rC, tC), toImg(rC, bC), toImg(lC, bC)];
  const out = [0, 1, 2, 3].map((j) => C[(tlIdx + j) & 3]);
  return { q: out, found: nFound, steps, frame: F, orientConf: o.orientConf, tcorr: o.tcorr, strength, snapped };
}

// ---------------------------------------------------------------------------
// public API

const toCont = (q) => q.map(([x, y]) => [x + 0.5, y + 0.5]);
const toIdx = (q) => q.map(([x, y]) => [x - 0.5, y - 0.5]);

function cardWidthOf(q) {
  const l = (a, b) => hyp2(a[0] - b[0], a[1] - b[1]);
  const s1 = (l(q[0], q[1]) + l(q[2], q[3])) / 2, s2 = (l(q[1], q[2]) + l(q[3], q[0])) / 2;
  return Math.min(s1, s2);
}

/** Order a clockwise quad so that q[0]->q[1] is a short side and q[0] is the card's TL. */
function orderCorners(img, q, P) {
  const f = P.focalRel * Math.max(img.w, img.h);
  const asp = rectAspect(q, f, img.w / 2, img.h / 2);
  let o = asp > 1 ? [q[1], q[2], q[3], q[0]] : q;
  let flip = false, conf = 0, tcorr = 0;
  if (P.orient) { const r = orientation(img, o, P); flip = r.flip; conf = r.conf; tcorr = r.best; }
  if (flip) o = [o[2], o[3], o[0], o[1]];
  return { q: o, orientConf: conf, tcorr };
}

function isLandscape(q) {
  // card top->bottom axis (mid TL-TR -> mid BL-BR) more horizontal than vertical
  const tx = (q[0][0] + q[1][0]) / 2, ty = (q[0][1] + q[1][1]) / 2, bx = (q[3][0] + q[2][0]) / 2, by = (q[3][1] + q[2][1]) / 2;
  return Math.abs(bx - tx) > Math.abs(by - ty);
}

/**
 * Detect the most central card in an RGBA frame.
 * opts: DEFAULTS overrides, plus prev (corners of the previous frame, continuous coords) as a temporal prior.
 * Returns {found, corners (TL,TR,BR,BL), score, landscape, ms, ...debug}.
 */
export function detect(img, opts = {}) {
  const t0 = now();
  const P = { ...DEFAULTS, ...opts };
  const { w, h } = img;
  const tm = {};
  let tt = now();
  const k = P.k || (w * h > 200000 ? 2 : 1);
  const G = gradientField(img, k);
  tm.grad = now() - tt; tt = now();
  const { segs, T } = segments(G, P);
  tm.lsd = now() - tt; tt = now();
  const pr = boxPrior(P, w, h);
  let lines = mergeLines(segs, P, G.w, G.h);
  if (pr) lines = priorLines(lines, pr, P.priorAngTol);
  tm.merge = now() - tt; tt = now();
  let hyp = hypotheses(lines, G.w, G.h, P);
  if (pr) { const n0 = hyp.nPairs; hyp = hyp.filter((c) => priorOk(c, pr, k, w, h, P)); hyp.nPairs = n0; }
  tm.hyp = now() - tt; tt = now();
  const top = diverse(hyp, P.topCands, 5);
  for (const c of top) scoreCand(c, G, img, T, P);
  tm.score = now() - tt; tt = now();
  let pool = top.filter((c) => c.score >= P.minScore * 0.8);
  // nested quads: prefer the outermost well-supported one
  pool.sort((a, b) => b.area - a.area);
  const keep = [];
  for (const c of pool) {
    const cen = [(c.q[0][0] + c.q[2][0]) / 2, (c.q[0][1] + c.q[2][1]) / 2];
    const parent = keep.find((k) => pointInQuad(cen, k.q, 2));
    if (!parent) { keep.push(c); continue; }
    // c inside an already kept (larger) quad
    const contained = c.q.every((p) => pointInQuad(p, parent.q, 0.03 * Math.sqrt(parent.area)));
    if (contained) {
      // replace the parent only if clearly better supported (parent is a bogus outer quad)
      if (c.score > parent.score + 0.18) { keep[keep.indexOf(parent)] = c; }
      continue;
    }
    // overlapping but not nested: two hypotheses of roughly the same card; keep the better
    if (c.score > parent.score) keep[keep.indexOf(parent)] = c;
  }
  let best = null;
  const valid = keep.filter((c) => c.score >= P.minScore);
  if (valid.length) {
    const maxS = Math.max(...valid.map((c) => c.score)), diag = hyp2(G.w, G.h);
    let prevC = null;
    if (P.prev) prevC = P.prev.map(([x, y]) => [x / k - 0.5, y / k - 0.5]);
    let bv = -Infinity;
    const comp = valid.filter((c) => c.score >= P.selRel * maxS).sort((a, b) => b.score - a.score).slice(0, P.selMax);
    for (const c of comp) {
      const cx = (c.q[0][0] + c.q[1][0] + c.q[2][0] + c.q[3][0]) / 4, cy = (c.q[0][1] + c.q[1][1] + c.q[2][1] + c.q[3][1]) / 4;
      // v2: card-likeness of the rectified layout joins the selection (a card-shaped checker square or
      // tile has full edge support but no card layout); an acceptable candidate beats any weak one
      let conf = c.score;
      if (comp.length > 1 && P.selLayout) {
        const qf = c.q.map(([x, y]) => [x * k + (k - 1) / 2, y * k + (k - 1) / 2]);
        conf = c.score + P.layoutW * (orderCorners(img, qf, P).tcorr - 0.5);
      }
      c.conf = conf;
      const ccx = pr ? pr.center[0] / k - 0.5 : G.w / 2, ccy = pr ? pr.center[1] / k - 0.5 : G.h / 2;
      let v = 0.15 * conf - (pr ? 1 + pr.weight : 1) * hyp2(cx - ccx, cy - ccy) / diag + (conf >= P.acceptScore ? P.selAcceptBonus : 0);
      if (prevC) {
        const pcx = (prevC[0][0] + prevC[2][0]) / 2, pcy = (prevC[0][1] + prevC[2][1]) / 2;
        v -= 1.0 * hyp2(cx - pcx, cy - pcy) / diag;
      }
      if (v > bv) { bv = v; best = c; }
    }
  }
  const res = { found: false, corners: null, score: best ? best.score : (top[0] ? top[0].score : 0), landscape: false,
    ms: 0, nSegs: segs.length, nLines: lines.length, nHyp: hyp.length, nPairs: hyp.nPairs };
  if (best) {
    let q = best.q.map(([x, y]) => [x * k + (k - 1) / 2, y * k + (k - 1) / 2]);
    let o = null, anchorFail = false;
    if (pr && P.anchor) {
      // box mode: no outward snap (it walks across black border -> ring -> platform -> floor); the card is
      // placed from its inner frame instead
      const fa = frameAnchor(img, q, P, pr);
      res.anchor = fa && { found: fa.found, steps: fa.steps, snapped: fa.snapped };
      if (fa && fa.q) o = { q: fa.q, orientConf: fa.orientConf, tcorr: fa.tcorr };
      else if (pr.quad && fa && fa.found >= P.priorQuadMinSides && quadNear(q, pr.quad, P.priorQuadTol)) {
        // dark-frame card (no bright inner frame on 3 sides) in the fixed box: the card lies where the
        // previous card lay (the stack grows ~0.3 mm per card); reuse the last accepted outline
        const pq = toIdx(pr.quad);
        o = { q: pq, orientConf: 0, tcorr: orderCorners(img, pq, P).tcorr };
        res.anchor.fromPrior = true;
      } else anchorFail = true;
    }
    if (!o && !pr && P.anchorFree && darkSurround(img, q, P) >= 3) {
      // free mode on a dark mat: the same frame anchoring when 3+ sides have a dark, neutral surround
      const fa = frameAnchor(img, q, P, null);
      if (fa && fa.q && fa.found === 4) { o = { q: fa.q, orientConf: fa.orientConf, tcorr: fa.tcorr }; res.anchor = { found: fa.found, steps: fa.steps, free: true }; }
    }
    let outer = null;
    if (!o && !pr && P.outerEdge) {
      outer = outerAnchor(img, q, P);
      if (!outer && P.outerAlt) {
        // the chosen quad may be only part of the card (title-to-type-line box, a frame drawn in the art)
        // while a larger hypothesis is the card: its anchored outline must contain the chosen quad's centre
        const cen = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
        const alt = top.filter((c) => c !== best && c.area > 1.15 * best.area && c.score >= P.minScore * 0.8)
          .sort((a, b) => b.score - a.score).slice(0, P.outerAlt);
        for (const c of alt) {
          const qc = c.q.map(([x, y]) => [x * k + (k - 1) / 2, y * k + (k - 1) / 2]);
          const fa = outerAnchor(img, qc, P);
          if (fa && pointInQuad(cen, fa.q) && Math.abs(quadArea(q)) < 0.85 * Math.abs(quadArea(fa.q))) { best = c; q = qc; outer = fa; break; }
        }
      }
    }
    if (!o) {
      if (P.snap && !pr) { const sn = snapOutward(img, q, P); q = sn.q; res.snapped = sn.moved; }
      if (P.refine) {
        const cw = cardWidthOf(q);
        const r = refineQuad(img, q, { bandIn: 2 + P.refBand * cw, bandOut: 2 + P.refBand * cw, rays: 40, angTol: P.refAng });
        if (r && convex(r) > 0 && maxShift(r, q) < 0.12 * cw) q = r;
      }
      if (outer && quadDist(q, outer.q) > P.outerAgree * cardWidthOf(outer.q)) {
        o = { q: outer.q, orientConf: outer.orientConf, tcorr: outer.tcorr };
        res.anchor = { found: outer.found, steps: outer.steps, free: true, outer: true };
      } else o = orderCorners(img, q, P);
    }
    // final confidence: edge/shape score plus how card-like the rectified layout looks
    const conf = best.score + P.layoutW * (o.tcorr - 0.5);
    res.score = Math.max(0, Math.min(1, conf));
    res.found = conf >= (pr ? P.boxAccept : res.anchor && res.anchor.outer ? P.outerAccept : P.acceptScore) && !anchorFail;
    res.mode = pr ? 'box' : 'free';
    res.weak = !res.found; // a card-ish quad below the bar (UI: yellow outline / "hold steady")
    res.corners = toCont(o.q);
    res.orientConf = o.orientConf;
    res.landscape = isLandscape(res.corners);
    res.support = best.sup;
    res.info = { score: best.score, sup: best.sup, ext: best.ext, extPen: best.extPen, inner: best.inner, dev: best.dev, orientConf: o.orientConf, tcorr: o.tcorr, snapped: res.snapped };
  }
  if (!pr && k === 2 && !P.k && P.fullResRetry > 0 && res.corners && !(res.found && res.score >= P.fullResRetry)) {
    const r1 = detect(img, { ...opts, k: 1 });
    if (r1.found && r1.corners && (!res.found || encloses(r1.corners, res.corners, P.fullResGrow))) {
      r1.fullRes = true;
      r1.ms = now() - t0;
      return r1;
    }
    res.fullResTried = true;
  }
  res.ms = now() - t0;
  if (P.debug) { res.dbg = { segs, lines, top, k, hyp }; res.dbgT = tm; }
  if (P.timing) { tm.post = now() - tt; res.tm = tm; }
  return res;
}

/** Quad a (continuous coords) is larger than grow x quad b and contains b's centre. */
function encloses(a, b, grow) {
  const c = [(b[0][0] + b[1][0] + b[2][0] + b[3][0]) / 4, (b[0][1] + b[1][1] + b[2][1] + b[3][1]) / 4];
  return Math.abs(quadArea(a)) > grow * Math.abs(quadArea(b)) && pointInQuad(c, a);
}

function maxShift(a, b) { let m = 0; for (let i = 0; i < 4; i++) m = Math.max(m, hyp2(a[i][0] - b[i][0], a[i][1] - b[i][1])); return m; }

/**
 * Full-resolution corner refinement. rough: corners (TL,TR,BR,BL, continuous coords) from detect()
 * scaled to this image. Keeps the corner order. Returns {corners, ok, ms}.
 */
export function refine(img, rough, opts = {}) {
  const t0 = now();
  const P = { ...DEFAULTS, ...opts };
  // box mode: the corners are placed from the inner frame + border model (the outer edge is invisible);
  // re-fitting them to visible lines would pull them onto the ring / platform rim
  if (boxPrior(P, img.w, img.h)) return { corners: rough, ok: true, snapped: 0, ms: now() - t0 };
  let q = toIdx(rough);
  let snapped = 0;
  if (P.snapFull) { const sn = snapOutward(img, q, P); q = sn.q; snapped = sn.moved; }
  const cw = cardWidthOf(q);
  const scale = opts.scale || Math.max(1, img.w / 480);
  // clockwise check (rough from detect is clockwise in y-down coords)
  const r = refineQuad(img, q, { bandIn: 1.5 * scale + 0.01 * cw, bandOut: 1.5 * scale + 0.01 * cw, rays: 64 });
  const ok = Boolean(r && convex(r) > 0 && maxShift(r, q) < 0.08 * cw);
  const corners = ok ? toCont(r) : snapped ? toCont(q) : rough;
  if (P.outerEdge && P.outerRefine) {
    // black border on a dark surround: the same inner-frame anchor as detect(), at full resolution.
    // It wins when the edge fit moved away from the rough outline (onto the inner frame or the platform
    // ring); an edge fit that confirms the rough outline is a visible card edge and stays.
    const ri = toIdx(rough), ci = toIdx(corners);
    const fa = quadDist(ci, ri) > P.outerAgree * cardWidthOf(ri) ? outerAnchor(img, ri, P) : null;
    if (fa) {
      const fw = cardWidthOf(fa.q), al = quadAlign(ri, fa.q);
      if (al.d < P.outerRefineTol * fw && quadDist(ci, fa.q) > P.outerAgree * fw) {
        // keep the rough corner order (refine never re-orients)
        const c = toCont(fa.q);
        return { corners: [0, 1, 2, 3].map((i) => c[(i + al.s) & 3]), ok: true, snapped, anchored: true, ms: now() - t0 };
      }
    }
  }
  return { corners, ok, snapped, ms: now() - t0 };
}
