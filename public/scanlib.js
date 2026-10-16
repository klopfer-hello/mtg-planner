// scanlib.js: browser-side card capture for the scanner (ES module, no deps).
//
// Why it exists: the server identifies cards from a rectified photo plus a
// sharp crop of the collector line, so the phone must find the card, straighten
// it and cut out the bottom strip. All pixel work is plain typed-array JS (no
// opencv.js, CSP stays as is), so everything except the camera/canvas helpers
// also runs in node for tests.
//
// Images: gray = {w, h, d: Float32Array}; RGBA = {w, h, d: Uint8ClampedArray}.
// Corners are always [TL, TR, BR, BL] as [x, y] in the image's pixel space.
//
// The detector is A2 (det/detect.mjs): anywhere in the frame, with a
// QuadTracker and a per-device learned box prior (createDetAnalyzer, feeding
// capture.js ProbeController). The classic guide-frame scanner was removed in
// v0.5.0. Also here: glare advice and the scan sounds (Web Audio, synthesized,
// no files).
//
// Main thread vs worker (v0.6.2, Pixel 9 report: the page froze): the camera
// frame is read on the main thread (drawImage + getImageData); everything
// heavy after that runs in a module worker when the browser has one
// (scanworker.js via createScanWorker): detect() per frame, the probe crop's
// perspective warps, its JPEG encoding (OffscreenCanvas) and the glare map.
// Without a worker the same code runs inline, with async JPEG encoding.
//
// Reading the frame (Pixel 9 beacon, 0.6.2-beta.1: 235 ms for the 480 px work
// frame + 220 ms for the strip sharpness per frame, each a full conversion of
// the 4K camera frame on the main thread). The strip sharpness now comes from
// the work frame (no second read), and on Chrome the work frame is drawn from
// a clone of the camera track constrained to the work size (a second, hidden
// <video>); the preview, probe and shutter crops keep the 4K track. The
// beta.2 MediaStreamTrackProcessor path (frames read in the worker) made the
// Pixel's camera stall (autofocus, preview): only behind ?scanframes=track.
// Safari/Firefox read the 4K <video> on the page as before.

import { detect, refine } from './det/detect.mjs';
import { QuadTracker, BoxPrior, PRIOR_STORAGE_KEY, frameThumb, align } from './det/track.mjs';

// frame pacing + perf beacon helpers (pure), re-exported for the page
export { FramePacer, PerfMonitor, PACER_DEFAULTS } from './scanperf.js';

/** Capture tuning. Values come from the synthetic-capture research. */
export const CAPTURE_DEFAULTS = Object.freeze({
  fps: 8,                 // analysis rate
  defaultFrac: 0.65,      // shutter fallback quad width as a fraction of the frame's short side
  cardSize: [1000, 1400], // rectified card upload
  cardQuality: 0.85,
  stripQuality: 0.92,
  // Bottom strip in card fractions, padded because on dark mats the inner
  // black border can be detected instead of the outer edge.
  stripRegion: Object.freeze({ x0: -0.03, y0: 0.85, x1: 1.03, y1: 1.04 }),
  stripMaxWidth: 2400,
  workShort: 480,         // analysis canvas short side (detector A2 was tuned at 480)
  photoLongSide: 1440,    // takePhoto re-detect runs on a copy this long (long side)
});

const CARD_ASPECT = 63 / 88;

// ---------------------------------------------------------------------------
// Basic image ops

export function toGray(img) {
  const { w, h, d } = img, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { w, h, d: g };
}

// ---------------------------------------------------------------------------
// Quality metric

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
// Shutter fallback quad

/**
 * Centred upright 63:88 card quad, `frac` of the frame's short side wide (height
 * capped at 92 %): what the shutter shoots when neither a tracked card nor a
 * learned box is available.
 */
export function defaultCardQuad(vw, vh, frac = CAPTURE_DEFAULTS.defaultFrac) {
  let w = frac * Math.min(vw, vh), h = w / CARD_ASPECT;
  if (h > 0.92 * vh) { h = 0.92 * vh; w = h * CARD_ASPECT; }
  const x = (vw - w) / 2, y = (vh - h) / 2;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
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

/**
 * Several regionPlan() rects of `src` (integer source rects) with ONE read of the source: a camera
 * frame is converted in full by every drawImage (Pixel 9: ~235 ms per read of a 4K frame), so the
 * card and strip of a probe are cut from one 1:1 copy of their union. A plan at scale 1 is copied
 * out exactly; a scaled one is drawn from the copy (same bilinear scaling as from the source). When
 * no plan is at scale 1 the union would be scaled, so each plan is read on its own as before.
 * @returns {{w:number,h:number,d:Uint8ClampedArray}[]} one RGBA image per plan (plan.dw x plan.dh)
 */
export function grabRegions(src, plans, mk = makeCanvas) {
  if (plans.length < 2 || !plans.some((p) => p.k === 1)) return plans.map((p) => grabRegion(src, p, p.k, mk));
  const x0 = Math.min(...plans.map((p) => p.x)), y0 = Math.min(...plans.map((p) => p.y));
  const x1 = Math.max(...plans.map((p) => p.x + p.w)), y1 = Math.max(...plans.map((p) => p.y + p.h));
  const u = mk(x1 - x0, y1 - y0), uctx = ctx2d(u);
  uctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, u.width, u.height);
  return plans.map((p) => {
    if (p.k === 1) {
      const id = uctx.getImageData(p.x - x0, p.y - y0, p.w, p.h);
      return { w: id.width, h: id.height, d: id.data };
    }
    return grabRegion(u, { x: p.x - x0, y: p.y - y0, w: p.w, h: p.h }, p.k, mk);
  });
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
 * photo with detector A2 on a copy `photoLongSide` (1440) px long, the mapped
 * quad as the temporal hint (corner order kept as the tracker had it). A re-detection more than
 * maxDrift (8 %) of the card width away from the mapped quad is rejected:
 * null = use the video frame instead.
 * @param {{width:number,height:number}} bitmap the still (ImageBitmap, or any drawable for opts.grab)
 * @param {object} [opts] {detOpts (detect() options), grab(src, rect, k) → RGBA
 *   (tests), photoLongSide, maxDrift, info (an object that receives {drift, reason, k})}
 * @returns {number[][]|null} corners in photo pixels
 */
export function mapToPhoto(bitmap, vw, vh, corners, opts = {}) {
  const { detOpts = {}, grab = grabRegion, photoLongSide = CAPTURE_DEFAULTS.photoLongSide, maxDrift = 0.08, info = {} } = opts;
  const pw = bitmap.width, ph = bitmap.height;
  const m = photoMapping(pw, ph, vw, vh);
  if (!m) { info.reason = "orientation"; return null; }
  const mapped = scaleQuad(corners, m.s, m.s, m.ox, m.oy);
  const b = quadBounds(mapped);
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
  const refined = scaleQuad([0, 1, 2, 3].map((i) => q[(i + a.s) & 3]), 1 / kx, 1 / ky);
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
export async function grabStill(video, track, corners, { preferPhoto = true, timeoutMs = 3500, detOpts } = {}) {
  const vw = video.videoWidth, vh = video.videoHeight;
  let drift = null, reject = null;
  if (preferPhoto && track && typeof globalThis.ImageCapture === "function" && typeof createImageBitmap === "function") {
    try {
      const ic = new globalThis.ImageCapture(track);
      const blob = await withTimeout(ic.takePhoto(), timeoutMs);
      const bmp = await createImageBitmap(blob);
      const info = {};
      const q = mapToPhoto(bmp, vw, vh, corners, { detOpts, info });
      drift = Number.isFinite(info.drift) ? Math.round(info.drift * 1e4) / 1e4 : null;
      if (q) return { source: bmp, w: bmp.width, h: bmp.height, corners: q, kind: "photo", drift, reject: null };
      reject = info.reason || "unknown";
      bmp.close?.();
    } catch { reject = reject || "error"; /* fall back to the video frame */ }
  }
  return { source: video, w: vw, h: vh, corners, kind: "video", drift, reject };
}

/**
 * The source rect around the region `region` (card fractions; null = the whole quad) of a still,
 * scaled so the region is ~outW * oversample wide: {x, y, w, h (still px, integers), k, dw, dh (the
 * read size), q (the region's corners in the read image's px, for warpQuad)}. grabRegions reads it
 * on the page, a frame source (worker crop) where the frames are.
 */
export function regionPlan(still, corners, region, outW, oversample = 1.3) {
  const q = region ? regionQuad(corners, region) : corners;
  const b = quadBounds(q), size = quadSize(q);
  // Clip the source rect to the still; warpQuad clamps sampling outside it.
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
  const w = Math.min(still.w, Math.ceil(b.x + b.w)) - x, h = Math.min(still.h, Math.ceil(b.y + b.h)) - y;
  if (w < 4 || h < 4) throw new Error("Card is outside the frame");
  const k = Math.min(1, (outW * oversample) / size.w);
  return { x, y, w, h, k, dw: Math.max(1, Math.round(w * k)), dh: Math.max(1, Math.round(h * k)), q: scaleQuad(q, k, k, -x * k, -y * k) };
}

/** RGBA image -> base64 JPEG (no data: prefix). Synchronous: blocks the main thread while encoding. */
export function encodeJpeg(img, quality) {
  const c = makeCanvas(img.w, img.h);
  ctx2d(c).putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
  const url = c.toDataURL("image/jpeg", quality);
  return url.slice(url.indexOf(",") + 1);
}

/** Bytes -> base64 (chunked, so a 400 KB JPEG never hits the argument limit). */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const asClamped = (d) => (d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d.buffer ?? d, d.byteOffset ?? 0, d.length ?? undefined));

/**
 * RGBA image -> base64 JPEG via canvas.toBlob (the browser encodes off the main
 * thread); toDataURL where toBlob is missing or yields nothing.
 */
export async function encodeJpegAsync(img, quality, mk = makeCanvas) {
  const c = mk(img.w, img.h);
  ctx2d(c).putImageData(new ImageData(asClamped(img.d), img.w, img.h), 0, 0);
  return canvasJpeg(c, quality);
}

/** A canvas -> base64 JPEG, asynchronously where toBlob exists. */
async function canvasJpeg(c, quality) {
  if (typeof c.toBlob === "function") {
    const blob = await new Promise((res) => { try { c.toBlob(res, "image/jpeg", quality); } catch { res(null); } });
    if (blob) return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  if (typeof c.toDataURL !== "function") return null;
  const url = c.toDataURL("image/jpeg", quality);
  return url.slice(url.indexOf(",") + 1);
}

/**
 * Glare of a rectified card as the probe path reports it: {code, advice (hint text | null),
 * regions (fractions rounded to 0.001), fraction}. `limits`: captureAdvice overrides.
 */
export function glareSummary(g, limits = null) {
  const code = captureAdvice(g, null, limits || {});
  const r3 = (v) => Math.round(v * 1000) / 1000, regions = {};
  for (const [k, v] of Object.entries(g.regions)) regions[k] = r3(v);
  return { code, advice: code === "ok" ? null : ADVICE_HINTS[code], regions, fraction: r3(g.fraction) };
}

const yieldTask = () => new Promise((r) => setTimeout(r, 0));
const clockNow = () => (globalThis.performance ? performance.now() : Date.now());
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Client of the scanner worker (public/scanworker.js, a module worker): ops 'detect' (detector A2
 * on a work frame), 'probe' (warp card + strip; JPEGs via OffscreenCanvas when the worker has one,
 * else the raw RGBA comes back), 'glareLast' (glare of the last probe card), 'glare' (warp + glare).
 * Jobs run one after another per worker. available() is false until the worker reported ready,
 * and for good after a load error, a crash or a timed-out job (callers then work inline).
 * @param {{url?: string|URL, WorkerCtor?: Function, timeoutMs?: number}} [opts]
 */
export function createScanWorker({ url = null, WorkerCtor = globalThis.Worker, timeoutMs = 10000 } = {}) {
  let w = null, broken = false, ready = false, encoder = false, seq = 0;
  const pending = new Map();
  const fail = (err) => {
    broken = true;
    for (const p of pending.values()) { clearTimeout(p.t); p.reject(err); }
    pending.clear();
    try { w?.terminate(); } catch { /* ignore */ }
  };
  if (typeof WorkerCtor !== "function") broken = true;
  else {
    try {
      w = new WorkerCtor(url || new URL("./scanworker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const m = e.data;
        if (m && m.ready) { ready = true; encoder = Boolean(m.encoder); return; }
        const p = m && pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.t);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || "scan worker error"));
      };
      w.onerror = (e) => { try { e?.preventDefault?.(); } catch { /* ignore */ } fail(new Error("scan worker failed")); };
      w.onmessageerror = () => fail(new Error("scan worker message error"));
    } catch { broken = true; w = null; }
  }

  function call(op, payload = {}, transfer = []) {
    if (broken || !w) return Promise.reject(new Error("scan worker unavailable"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (pending.has(id)) fail(new Error("scan worker timeout")); }, timeoutMs);
      pending.set(id, { resolve, reject, t });
      try { w.postMessage({ ...payload, id, op }, transfer); } catch (e) { pending.delete(id); clearTimeout(t); reject(e); }
    });
  }

  return {
    call,
    available: () => ready && !broken,
    get encoder() { return encoder; },
    get state() { return broken ? "off" : ready ? "ready" : "loading"; },
    close: () => fail(new Error("scan worker closed")),
  };
}

/**
 * Full capture: still -> rectified 1000x1400 card (q85) + high-res bottom
 * strip (q92). `corners` are the tracker-smoothed video-space corners (or the
 * learned box / defaultCardQuad for a shutter shot without a tracked card).
 * cfg: CAPTURE_DEFAULTS overrides plus grabStill options ({preferPhoto,
 * detOpts}; the analyzer hands them out via captureOpts()), `pixels` (a
 * createScanWorker client: the warps, JPEGs and glare run there) and `glare`
 * (true: also measure the card's glare, a promise that settles after the
 * JPEGs, so it never delays the upload; glareMap of the 1000 px card works on
 * the same 500x700 planes as the old separate 500x700 rectify).
 * Only the pixel read (drawImage + getImageData, one read of the card+strip
 * union: grabRegions) stays on the main thread, and not even that with cfg.crop
 * (the analyzer's crop(): a video still's card and strip regions are read where
 * the camera frames are, e.g. the scan worker); the JPEGs are encoded
 * asynchronously (worker OffscreenCanvas, else toBlob).
 * Returns {card, strip, cardPreview (data URL), kind, stripSize, drift, reject,
 * glare (Promise<glareSummary|null>|null), worker, crop (read via cfg.crop),
 * ms {grab (main-thread reads), crop, job (worker warps + JPEGs, null inline), total}}.
 */
export async function captureCard(video, track, corners, cfg = {}) {
  const c = { ...CAPTURE_DEFAULTS, ...cfg };
  const mk = cfg.makeCanvas || makeCanvas;
  const t0 = clockNow();
  const still = await grabStill(video, track, corners, cfg);
  const [cw, ch] = c.cardSize;
  const r = c.stripRegion;
  let sw, sh, grabMs = 0, jobMs = null, cardB64, stripB64, glare = null, worker = false;
  // The pixel reads (main thread). The still stays open until the JPEGs exist: a failed or timed-out
  // worker job (its pixels were transferred) reads them again and finishes inline, so a shutter
  // tap is never lost.
  // card + strip with one read of the still (grabRegions: one conversion of the camera frame)
  const grab = () => {
    const t = clockNow();
    const pc = regionPlan(still, still.corners, null, cw, 1.3), ps = regionPlan(still, still.corners, r, sw, 1);
    const [ci, si] = grabRegions(still.source, [pc, ps], mk);
    const g = { card: { img: ci, q: pc.q }, strip: { img: si, q: ps.q } };
    grabMs += clockNow() - t;
    return g;
  };
  // the video frame's regions read by the frame source (cfg.crop, the analyzer's worker): no
  // full-res read on this thread; null when it has no frame (then grab() reads them here)
  let cropped = false, cropMs = 0;
  const cropGrab = async () => {
    if (typeof c.crop !== "function" || still.kind !== "video") return null;
    const t = clockNow();
    try {
      const pc = regionPlan(still, still.corners, null, cw, 1.3), ps = regionPlan(still, still.corners, r, sw, 1);
      const imgs = await c.crop([pc, ps].map(({ x, y, w, h, dw, dh }) => ({ x, y, w, h, dw, dh })));
      if (!imgs || imgs.length !== 2) return null;
      cropped = true;
      return { card: { img: imgs[0], q: pc.q }, strip: { img: imgs[1], q: ps.q } };
    } catch { return null; } finally { cropMs += clockNow() - t; }
  };
  try {
    const ss = quadSize(regionQuad(still.corners, r));
    sw = Math.max(200, Math.min(c.stripMaxWidth, Math.round(ss.w)));
    sh = Math.max(40, Math.round(sw * ((r.y1 - r.y0) * 88) / ((r.x1 - r.x0) * 63)));
    let g = (await cropGrab()) || grab();
    const px = c.pixels && c.pixels.available() ? c.pixels : null;
    if (px) {
      const tj = clockNow();
      try {
        const job = px.call("probe", {
          card: { img: g.card.img, q: g.card.q, outW: cw, outH: ch, quality: c.cardQuality },
          strip: { img: g.strip.img, q: g.strip.q, outW: sw, outH: sh, quality: c.stripQuality },
          glare: Boolean(c.glare),
        }, [g.card.img.d.buffer, g.strip.img.d.buffer]);
        const gl = c.glare ? px.call("glareLast", {}).catch(() => null) : null;
        const out = await job;
        if (out.raw) [cardB64, stripB64] = await Promise.all([encodeJpegAsync(out.card, c.cardQuality, mk), encodeJpegAsync(out.strip, c.stripQuality, mk)]);
        else { cardB64 = out.card; stripB64 = out.strip; }
        glare = gl;
        worker = true;
      } catch {
        g = grab();
      }
      jobMs = clockNow() - tj;
    }
    if (!worker) {
      const card = warpQuad(g.card.img, g.card.q, cw, ch);
      await yieldTask();
      const strip = warpQuad(g.strip.img, g.strip.q, sw, sh);
      [cardB64, stripB64] = await Promise.all([encodeJpegAsync(card, c.cardQuality, mk), encodeJpegAsync(strip, c.stripQuality, mk)]);
      if (c.glare) glare = yieldTask().then(() => glareSummary(glareMap(card))).catch(() => null);
    }
  } finally {
    if (still.source && still.source !== video) still.source.close?.();
  }
  return {
    card: cardB64,
    strip: stripB64,
    cardPreview: `data:image/jpeg;base64,${cardB64}`,
    kind: still.kind,
    stripSize: [sw, sh],
    drift: still.drift ?? null,
    reject: still.reject ?? null,
    glare,
    worker,
    crop: cropped,
    ms: { grab: r1(grabMs), crop: r1(cropMs), job: jobMs === null ? null : r1(jobMs), total: r1(clockNow() - t0) },
  };
}

// ---------------------------------------------------------------------------
// Detector A2 + tracker + learned box prior

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
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
 * Frame analysis. Per analyze(now): the video is drawn at 480 px
 * short side, detect(img, prior.opts(w, h)) → BoxPrior.noteFrame → QuadTracker;
 * the prior observes each new stable outline while it is inactive (as in the
 * research replay). Sharpness is measured on the tracked quad's bottom 14 % of
 * the work frame (stripSharpness; it was the full-res strip before 0.6.2-beta.3,
 * a second camera-frame read). Glare (detection only, ~45 ms on a desktop CPU) runs on a
 * rectified 500x700 card only once the track has been stable for glareDelayMs
 * (800: a capture normally fires ~3 frames after stable, so the hint is for a
 * card that sits still without being taken) and then every glareEveryMs (1500).
 *
 * FrameAnalysis (capture.js ProbeController.step() input): {vw, vh, found
 * (a tracked outline this frame), weak (found, detection below the bar),
 * accepted, stable, corners (smoothed, video px, TL,TR,BR,BL), rawCorners,
 * jitter, drift, mode, score, orientConf, thumb (24x40), cardThumb (12x16),
 * sharp, glare {advice, code, regions}, priorQuad (video px | null),
 * priorLearned (box mode active), now, ms, timing {main, grab, detect, sharp,
 * mode, worker}}.
 *
 * analyzeAsync(now) is the same with detect() in opts.detectWorker (a
 * createScanWorker client) once it is ready; opts.pixels (another client)
 * takes the stable-track glare map off the main thread (the hint then lands
 * one answer later). opts.grabMode 'cpu' (default) | 'gpu' | 'auto' picks the
 * work-frame canvas (see grab()). opts.frames 'main' (default) | 'clone' |
 * 'auto' | 'track' | 'bitmap' (+ opts.track, the camera's MediaStreamTrack, and
 * opts.cloneVideo, a hidden <video> for the clone) picks where the work frame
 * comes from: 'clone' draws it from a clone of the track constrained to the work
 * size, 'auto' = clone on Chromium (opts.chromium, else navigator.userAgentData),
 * else main; 'track'/'bitmap' are the beta.2 worker paths (experiments only, see
 * the frame path note in the body); crop(rects) then reads probe/glare regions
 * the same way (captureCard cfg.crop), close() stops it. opts.workerGrabMode
 * 'cpu' | 'gpu' fixes the worker's canvas.
 *
 * The learned box persists per device in localStorage mtg.scan.prior:
 * loadPrior() on create, savePrior() after each accepted capture (it adds that
 * capture to the prior first: the given video corners, else the last frame's
 * accepted track, once per stable run).
 *
 * @param {HTMLVideoElement|{videoWidth:number, videoHeight:number}} video
 * @param {object} [opts] {workShort, storage, makeCanvas (tests), prior/tracker (instances),
 *   priorOpts, trackerOpts, glare (true), glareDelayMs (800), glareEveryMs (1500), blankSharp (DET_BLANK_SHARP), now,
 *   detectWorker, pixels, grabMode, frames, track, cloneVideo, chromium}
 *
 * An outline whose strip is blank (sharp < blankSharp) is reported as no card
 * (found/accepted/stable false, corners/cardThumb null, blank true; sharp and
 * rawCorners kept): the capture controller then asks for a card instead of
 * calling the empty box "Too blurry".
 */
/**
 * Strip sharpness (Laplacian variance of the bottom 14 %, stripSharpness) below
 * which a tracked outline holds no card: the outline of an empty scan box (box
 * mode / learned prior) has a flat white bottom strip. Recorded session
 * 2026-10-14 (1002 frames, 167 probes), full-res strip: the empty box read
 * 7-19, every frame around a staged/same probe 163+ (p1 612, p50 1543), so the
 * old "Too blurry" hint at the start was the empty box, not a blurry card.
 * Since 0.6.2-beta.3 it is measured on the 480 px work frame, as the
 * regression replay always did (its recordings are work frames): there the
 * empty box reads 0-10 and the work/full-res ratio is ~1.4-2.6 (p50; down-
 * scaling packs the edges), so 40 (and the controllers' sharpFloor 60) keep
 * the same split with more margin on both sides.
 */
export const DET_BLANK_SHARP = 40;

/**
 * Laplacian variance of the bottom 14 % of quad `q` (TL,TR,BR,BL in `img` px), read from the RGBA
 * image `img` like a canvas drawImage of that rect (bilinear, <= 640 px wide, pixel centres); 0 when
 * the strip lies outside the image. On the 480 px work frame this is the per-frame sharpness gate.
 */
export function stripSharpness(img, q) {
  const sr = quadBounds(regionQuad(q, { x0: 0, y0: 0.86, x1: 1, y1: 1 }));
  const sx = Math.max(0, sr.x), sy = Math.max(0, sr.y), sw = Math.min(img.w - sx, sr.w), sh = Math.min(img.h - sy, sr.h);
  if (!(sw > 8 && sh > 4)) return 0;
  const k = Math.min(1, 640 / sw);
  const dw = Math.max(8, Math.round(sw * k)), dh = Math.max(4, Math.round(sh * k));
  const { w, h, d } = img, g = new Float32Array(dw * dh), kx = sw / dw, ky = sh / dh, px = new Uint8ClampedArray(3);
  for (let y = 0; y < dh; y++) {
    const fy0 = Math.min(h - 1, Math.max(0, sy + (y + 0.5) * ky - 0.5));
    const y0 = Math.min(h - 2, Math.floor(fy0)), fy = fy0 - y0;
    for (let x = 0; x < dw; x++) {
      const fx0 = Math.min(w - 1, Math.max(0, sx + (x + 0.5) * kx - 0.5));
      const x0 = Math.min(w - 2, Math.floor(fx0)), fx = fx0 - x0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
      for (let k3 = 0; k3 < 3; k3++) px[k3] = d[i00 + k3] * a + d[i10 + k3] * b + d[i01 + k3] * c + d[i11 + k3] * e;
      g[y * dw + x] = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
    }
  }
  return laplacianVariance({ w: dw, h: dh, d: g });
}

/** True on Chromium browsers (navigator.userAgentData brands); false elsewhere and in node. */
export function isChromium() {
  try {
    const brands = globalThis.navigator?.userAgentData?.brands;
    return Array.isArray(brands) && brands.some((b) => /Chromium|Google Chrome/i.test(String(b?.brand)));
  } catch { return false; }
}

/**
 * Whether a cw x ch analysis clone shows the same view as the vw x vh video: same orientation and
 * aspect within 1 % (crop-and-scale crops when the asked size has another aspect).
 */
export function cloneMatches(cw, ch, vw, vh) {
  if (!(cw > 0 && ch > 0 && vw > 0 && vh > 0) || (cw > ch) !== (vw > vh)) return false;
  return Math.abs((cw / ch) / (vw / vh) - 1) <= 0.01;
}

/**
 * How a cw x ch analysis clone relates to the vw x vh video: 'same' (cloneMatches), 'swapped' (its
 * width/height are the video's swapped, aspect within 1 %: Android Chrome 155 delivers a landscape
 * 853x480 clone of a portrait 2160x3840 track) or null (another view).
 */
export function cloneRelation(cw, ch, vw, vh) {
  if (cloneMatches(cw, ch, vw, vh)) return "same";
  if (cloneMatches(ch, cw, vw, vh)) return "swapped";
  return null;
}

/**
 * The rotated clone's check (createDetAnalyzer): thumbnails at `short` px short side, a winner needs
 * normalised correlation ≥ minScore and ≥ margin over the other candidate, flat thumbnails (gray std <
 * minStd) are never judged; `tries` attempts `everyMs` apart, then the clone is dropped
 * ('clone:rotation-unclear').
 */
export const CLONE_ROT = Object.freeze({ short: 16, minScore: 0.5, margin: 0.2, minStd: 3, tries: 8, everyMs: 300 });

/** Gray tw x th thumbnail of an RGBA image {w, h, d} (area average): {w, h, d Float32Array}. */
export function grayThumb(img, tw, th) {
  const { w, h, d } = img, out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let s = 0, n = 0;
      for (let y = y0; y < y1 && y < h; y++) for (let x = x0; x < x1 && x < w; x++) {
        const i = (y * w + x) * 4;
        s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        n++;
      }
      out[ty * tw + tx] = n ? s / n : 0;
    }
  }
  return { w: tw, h: th, d: out };
}

/** A gray image {w, h, d} rotated clockwise by rot (0 | 90 | 180 | 270 degrees). */
export function rotateGray(g, rot) {
  const { w, h, d } = g, r = ((rot % 360) + 360) % 360;
  if (r === 0) return { w, h, d: Float32Array.from(d) };
  const ow = r === 180 ? w : h, oh = r === 180 ? h : w, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (r === 90) { nx = h - 1 - y; ny = x; } else if (r === 270) { nx = y; ny = w - 1 - x; } else { nx = w - 1 - x; ny = h - 1 - y; }
    out[ny * ow + nx] = d[y * w + x];
  }
  return { w: ow, h: oh, d: out };
}

// zero-mean normalised correlation of two same-size gray images; null when one is flat
function ncc(a, b, minStd) {
  const n = a.d.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a.d[i]; mb += b.d[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a.d[i] - ma, y = b.d[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  if (Math.sqrt(saa / n) < minStd || Math.sqrt(sbb / n) < minStd) return null;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Which clockwise rotation turns the clone's thumbnail into the video's: candidates [90, 270] when the
 * clone is the video's size swapped, else [0, 180]. {rot (null = unclear), score (best correlation),
 * margin (over the runner-up), scores {rot: corr}, why ('flat'|'size'|'weak'|'margin' when unclear)}.
 */
export function chooseCloneRotation(cloneThumb, videoThumb, cfg = {}) {
  const c = { ...CLONE_ROT, ...cfg };
  const swapped = cloneThumb.w === videoThumb.h && cloneThumb.h === videoThumb.w && cloneThumb.w !== cloneThumb.h;
  const same = cloneThumb.w === videoThumb.w && cloneThumb.h === videoThumb.h;
  if (!swapped && !same) return { rot: null, score: null, margin: null, scores: {}, why: "size" };
  const cands = c.candidates || (swapped ? [90, 270] : [0, 180]);
  const scores = {};
  for (const r of cands) {
    const g = rotateGray(cloneThumb, r);
    if (g.w !== videoThumb.w || g.h !== videoThumb.h) continue;
    const s = ncc(g, videoThumb, c.minStd);
    if (s === null) return { rot: null, score: null, margin: null, scores, why: "flat" };
    scores[r] = Math.round(s * 1000) / 1000;
  }
  const ranked = Object.entries(scores).sort((x, y) => y[1] - x[1]);
  if (!ranked.length) return { rot: null, score: null, margin: null, scores, why: "size" };
  const score = ranked[0][1], margin = ranked.length > 1 ? Math.round((score - ranked[1][1]) * 1000) / 1000 : score;
  if (score < c.minScore) return { rot: null, score, margin, scores, why: "weak" };
  if (margin < c.margin) return { rot: null, score, margin, scores, why: "margin" };
  return { rot: Number(ranked[0][0]), score, margin, scores, why: null };
}

/**
 * Canvas transform [a, b, c, d, e, f] that draws a clone frame rotated clockwise by rot into a W x H
 * work canvas (video orientation); the clone is drawn at (0, 0, H, W) for 90/270 and (0, 0, W, H) for 0.
 * A clone point (x, y) of a cw x ch frame lands at cloneToWork(rot, x, y, cw, ch, W, H).
 */
export function rotationTransform(rot, W, H) {
  if (rot === 90) return [0, 1, -1, 0, W, 0];
  if (rot === 270) return [0, -1, 1, 0, 0, H];
  if (rot === 180) return [-1, 0, 0, -1, W, H];
  return [1, 0, 0, 1, 0, 0];
}

/** Work-frame point (W x H, video orientation) of clone point (x, y) in a cw x ch clone frame rotated by rot. */
export function cloneToWork(rot, x, y, cw, ch, W, H) {
  const [dw, dh] = rot === 90 || rot === 270 ? [H, W] : [W, H];
  const u = (x * dw) / cw, v = (y * dh) / ch;
  const [a, b, c, d, e, f] = rotationTransform(rot, W, H);
  return [a * u + c * v + e, b * u + d * v + f];
}

export function createDetAnalyzer(video, opts = {}) {
  const workShort = opts.workShort || CAPTURE_DEFAULTS.workShort;
  const mk = opts.makeCanvas || makeCanvas;
  const storage = "storage" in opts ? opts.storage : defaultStorage();
  const clock = opts.now || (() => (globalThis.performance ? performance.now() : Date.now()));
  const prior = opts.prior || new BoxPrior({ mode: "auto", ...(opts.priorOpts || {}) });
  const tracker = opts.tracker || new QuadTracker(opts.trackerOpts || {});
  const blankSharp = opts.blankSharp ?? DET_BLANK_SHARP;
  const glareOn = opts.glare !== false, glareEveryMs = opts.glareEveryMs ?? 1500, glareDelayMs = opts.glareDelayMs ?? 800;
  const detectWorker = opts.detectWorker || null, pixels = opts.pixels || null;
  const noGlare = () => ({ advice: null, code: "ok", regions: null });
  let work = null, workImg = null, last = null, wasStable = false, runId = 0, addedRun = -1;
  // Frame path (who reads the camera frame): 'main' (drawImage of the <video> + getImageData here),
  // 'clone' (the same, from a clone of the camera track constrained to the work size, shown in the
  // hidden opts.cloneVideo; the 4K track stays for the preview and the probe/shutter crops), 'track'
  // (a MediaStreamTrackProcessor feeds the detect worker) or 'bitmap' (createImageBitmap here, the
  // worker reads it). opts.frames 'auto' = clone on Chromium, else main (Safari, Firefox). 'track'
  // and 'bitmap' are experiments (0.6.2-beta.2: the processor held camera frames and stalled the
  // Pixel 9's camera). A failing path falls back for good: clone -> main, track -> bitmap -> main.
  const framePref = opts.frames || "main", camTrack = opts.track || null, cloneVideo = opts.cloneVideo || null;
  const chromium = opts.chromium ?? isChromium();
  let path = null, pathWhy = null, attached = null, attachedAt = 0, wgrabMode = null;
  // the analysis clone: {state 'pending'|'ready'|'off', track, frames (clone video frames seen), lastAt,
  // miss (frames whose clone didn't match the video)}; cloneInfo = what the beacon reports
  let cl = null;
  const cloneInfo = {};
  const frameOpts = { mode: opts.workerGrabMode === "cpu" || opts.workerGrabMode === "gpu" ? opts.workerGrabMode : undefined };
  let glare = noGlare(), glareAt = -Infinity, stableSince = null, glarePending = false;
  // Work-frame read: 'cpu' (willReadFrequently canvas, the tested default), 'gpu' (accelerated canvas:
  // the browser scales the camera frame on the GPU and reads back only 480 px; Android keeps camera
  // frames on the GPU) or 'auto' (time both on the first frames, keep 'gpu' only when clearly faster).
  const grabPref = opts.grabMode || "cpu";
  let grabMode = grabPref === "auto" ? null : grabPref;
  const grabTrials = { cpu: [], gpu: [] }, GRAB_TRIALS = 6, GRAB_WARM = 2;
  const canvases = new Map();

  const toVideo = (q, s) => (q ? q.map(([x, y]) => [x / s, y / s]) : null);
  const canvasFor = (kind, mode, w, h) => {
    const key = `${kind}:${mode}`;
    let c = canvases.get(key);
    if (!c || c.width !== w || c.height !== h) { c = mk(w, h); canvases.set(key, c); }
    return c;
  };
  const ctxOf = (c, mode) => (mode === "gpu" ? c.getContext("2d") : ctx2d(c));
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : Infinity; };

  function pickMode() {
    if (grabMode) return grabMode;
    const { cpu, gpu } = grabTrials;
    if (cpu.length >= GRAB_TRIALS + GRAB_WARM && gpu.length >= GRAB_TRIALS + GRAB_WARM) {
      grabMode = median(gpu.slice(GRAB_WARM)) < 0.85 * median(cpu.slice(GRAB_WARM)) ? "gpu" : "cpu";
      return grabMode;
    }
    return cpu.length <= gpu.length ? "cpu" : "gpu";
  }

  // full-res video region around `quad` so the card is ~targetW*1.3 wide: {x, y, w, h, k, dw, dh, q (read px)}
  function rectPlan(quad, targetW) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
    const w = Math.min(vw, Math.ceil(Math.max(...xs))) - x, h = Math.min(vh, Math.ceil(Math.max(...ys))) - y;
    if (!(w >= 4 && h >= 4)) return null;
    const k = Math.min(1, (targetW * 1.3) / quadSize(quad).w);
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k)), kx = dw / w, ky = dh / h;
    return { x, y, w, h, k, dw, dh, q: quad.map(([a, b]) => [(a - x) * kx, (b - y) * ky]) };
  }

  // the same region read here (main thread)
  function rectGrab(quad, targetW) {
    const p = rectPlan(quad, targetW);
    return p ? { img: grabRegion(video, p, p.k, mk), q: p.q } : null;
  }

  // rectified outW x outH card of `quad` from the current video frame
  function rectify(quad, targetW, outW, outH) {
    const g = rectGrab(quad, targetW);
    return g ? warpQuad(g.img, g.q, outW, outH) : null;
  }

  // the stable-track glare hint, measured in the pixel worker (the pixel read here, or by the frame
  // path; `work` = {img, q} of the work frame on the clone path: no camera-frame read for an advisory hint)
  async function requestGlare(quad, work = null) {
    glarePending = true;
    const run = runId;
    try {
      let g = work;
      if (!g && (path === "track" || path === "bitmap")) {
        const p = rectPlan(quad, 500);
        const imgs = p ? await crop([p]) : null;
        if (imgs) g = { img: imgs[0], q: p.q };
      }
      if (!g) g = rectGrab(quad, 500);
      if (!g) return;
      const sm = await pixels.call("glare", { img: g.img, q: g.q, outW: 500, outH: 700, limits: { typeLine: Infinity } }, [g.img.d.buffer]);
      if (sm && run === runId && last?.seen) glare = { advice: sm.advice, code: sm.code, regions: sm.regions };
    } catch { /* glare is advisory only */ } finally { glarePending = false; }
  }

  // the camera frame at 480 px short side (main thread: drawImage + getImageData), from the analysis
  // clone when it is running and shows the video's view, else from the <video>
  // A rotated clone is drawn turned into the video's orientation (rotationTransform), so the work frame,
  // and every coordinate the analysis returns (work px / s = video px), is the same as on the main path.
  function grab() {
    const t0 = clock();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const { W, H, s } = workSize(vw, vh, workShort);
    const cs = cloneSource(vw, vh, t0);
    const src = cs.el;
    const mode = pickMode();
    const c = canvasFor("work", mode, W, H), wctx = ctxOf(c, mode);
    if (cs.rot) {
      wctx.setTransform(...rotationTransform(cs.rot, W, H));
      if (cs.rot === 180) wctx.drawImage(src, 0, 0, W, H);
      else wctx.drawImage(src, 0, 0, H, W);
      wctx.setTransform(1, 0, 0, 1, 0, 0);
    } else wctx.drawImage(src, 0, 0, W, H);
    const id = wctx.getImageData(0, 0, W, H);
    work = c;
    workImg = null;
    const grabMs = clock() - t0;
    if (!grabMode && src === video) grabTrials[mode].push(grabMs);
    const img = { w: W, h: H, d: id.data };
    if (cs.verify) verifyClone(cs, img, vw, vh, t0);
    return { vw, vh, W, H, s, img, t0, grabMs, mode, src: src === video ? "main" : "clone" };
  }

  // -- analysis clone (path 'clone') --
  const settingsOf = (t) => { try { return t?.getSettings?.() || {}; } catch { return {}; } };
  const canClone = () => Boolean(camTrack && typeof camTrack.clone === "function" && camTrack.readyState !== "ended"
    && cloneVideo && "srcObject" in cloneVideo && typeof globalThis.MediaStream === "function");
  const cloneErr = (why) => Object.assign(new Error(`clone: ${why}`), { why });

  // {el: the clone video when it is ready, delivers frames and shows the video's view (rot: how it is
  // turned), else the video; verify: set while a swapped clone's rotation is being checked}
  function cloneSource(vw, vh, now) {
    const VID = { el: video, rot: 0 };
    if (!cl || (cl.state !== "ready" && cl.state !== "verify")) return VID;
    const cw = cloneVideo.videoWidth, ch = cloneVideo.videoHeight;
    const rel = cloneRelation(cw, ch, vw, vh);
    if (!rel) {
      // e.g. a rotation the clone has not followed yet: this frame from the video; for good after ~30
      if (++cl.miss >= 30) offClone("aspect");
      return VID;
    }
    cl.miss = 0;
    // requestVideoFrameCallback counts the clone's frames where it fires: a clone that stopped
    // delivering (a hidden <video> the browser no longer updates) must never feed stale frames
    if (cl.frames > 0 && now - cl.lastAt > 1000) {
      if (now - cl.lastAt > 3000) offClone("stalled");
      return VID;
    }
    const key = `${cw}x${ch}/${vw}x${vh}`;
    if (cl.state === "ready" && key !== cl.key) {
      // the sizes changed (device rotation, camera restart): an unrotated clone as before, a swapped one
      // is checked again
      if (rel === "same") { cl.rot = 0; cl.key = key; Object.assign(cloneInfo, { rot: 0 }); }
      else Object.assign(cl, { state: "verify", tries: 0, nextTry: 0 });
    }
    if (cl.state === "verify") {
      if (rel === "same") { Object.assign(cl, { state: "ready", rot: 0, key }); Object.assign(cloneInfo, { rot: 0 }); return { el: cloneVideo, rot: 0 }; }
      return { ...VID, verify: true, key, cw, ch };
    }
    return { el: cloneVideo, rot: cl.rot || 0 };
  }

  /**
   * A swapped clone (landscape clone of a portrait video or the reverse): which way it is turned is
   * decided from one clone frame and the video frame read just now (the work frame), compared as gray
   * thumbnails (chooseCloneRotation). Retried CLONE_ROT.tries times (a moving or flat scene), then off.
   */
  function verifyClone(cs, img, vw, vh, now) {
    const st = cl;
    if (!st || st.state !== "verify" || now < st.nextTry) return;
    if (st.rvfc && st.frames === 0) {
      if (now - st.readyAt > 3000) offClone("no-frames");
      return;
    }
    st.nextTry = now + CLONE_ROT.everyMs;
    st.tries++;
    let res = null;
    try {
      const t = workSize(vw, vh, CLONE_ROT.short), tw = t.W, th = t.H;
      const vt = grayThumb(img, tw, th);
      const cc = canvasFor("rot", "cpu", th * 4, tw * 4), cx = ctx2d(cc);
      cx.drawImage(cloneVideo, 0, 0, th * 4, tw * 4);
      const ct = grayThumb({ w: th * 4, h: tw * 4, d: cx.getImageData(0, 0, th * 4, tw * 4).data }, th, tw);
      res = chooseCloneRotation(ct, vt);
    } catch { res = null; }
    Object.assign(cloneInfo, { rot: res?.rot ?? null, rot_score: res?.score ?? null, rot_margin: res?.margin ?? null, rot_tries: st.tries, rot_why: res ? res.why : "error" });
    if (res && res.rot !== null) {
      Object.assign(st, { state: "ready", rot: res.rot, key: cs.key });
      return;
    }
    if (st.tries >= CLONE_ROT.tries) offClone("rotation-unclear");
  }

  /**
   * Start the analysis clone: camTrack.clone() at the work size (in the track's own width/height
   * convention: Android may report the sensor's landscape size for a portrait video), crop-and-scale,
   * into the hidden cloneVideo. A clone whose size is the video's swapped (Android Chrome: a landscape
   * clone of the portrait track) is used once verifyClone knows its rotation, drawn turned. Off (back to
   * the video, reason in grabInfo().why) when the original track's size changed, the clone is not
   * smaller, shows another view, its rotation stays unclear or it delivers nothing in 3 s.
   */
  async function attachClone() {
    const t0 = clock();
    const st = { state: "pending", track: null, frames: 0, lastAt: 0, miss: 0, rot: 0, key: null, rvfc: false, readyAt: 0, tries: 0, nextTry: 0 };
    cl = st;
    try {
      const s0 = settingsOf(camTrack);
      const vw = video.videoWidth, vh = video.videoHeight;
      const tw = s0.width || vw, th = s0.height || vh;
      const ws = workSize(tw, th, workShort);
      Object.assign(cloneInfo, { ask_w: ws.W, ask_h: ws.H, ow0: s0.width ?? null, oh0: s0.height ?? null });
      st.track = camTrack.clone();
      await st.track.applyConstraints({ width: { ideal: ws.W }, height: { ideal: ws.H }, resizeMode: "crop-and-scale" });
      if (cl !== st) throw cloneErr("closed");
      const s1 = settingsOf(camTrack);
      if (s0.width && (s1.width !== s0.width || s1.height !== s0.height)) throw cloneErr("orig-changed");
      cloneVideo.muted = true;
      cloneVideo.playsInline = true;
      try { cloneVideo.setAttribute?.("playsinline", ""); cloneVideo.setAttribute?.("muted", ""); } catch { /* ignore */ }
      cloneVideo.srcObject = new globalThis.MediaStream([st.track]);
      const played = cloneVideo.play?.();
      if (played?.catch) played.catch(() => {});
      for (let i = 0; i < 60 && !cloneVideo.videoWidth && cl === st; i++) await new Promise((r) => setTimeout(r, 50));
      if (cl !== st) throw cloneErr("closed");
      const cw = cloneVideo.videoWidth, ch = cloneVideo.videoHeight, cs = settingsOf(st.track), s2 = settingsOf(camTrack);
      Object.assign(cloneInfo, {
        w: cw || null, h: ch || null, set_w: cs.width ?? null, set_h: cs.height ?? null, resize: cs.resizeMode ?? null,
        ow1: s2.width ?? null, oh1: s2.height ?? null, setup_ms: r1(clock() - t0),
      });
      if (!cw || !ch) throw cloneErr("no-frames");
      if (s0.width && (s2.width !== s0.width || s2.height !== s0.height)) throw cloneErr("orig-changed");
      const vw2 = video.videoWidth || vw, vh2 = video.videoHeight || vh;
      if (Math.min(cw, ch) > 0.75 * Math.min(vw2, vh2)) throw cloneErr("not-scaled");
      const rel = cloneRelation(cw, ch, vw2, vh2);
      if (!rel) throw cloneErr("aspect");
      st.rvfc = typeof cloneVideo.requestVideoFrameCallback === "function";
      if (st.rvfc) {
        const onFrame = () => {
          if (cl !== st || st.state === "off") return;
          st.frames++;
          st.lastAt = clock();
          try { cloneVideo.requestVideoFrameCallback(onFrame); } catch { /* counting stops: no stale check */ }
        };
        try { cloneVideo.requestVideoFrameCallback(onFrame); } catch { /* ignore */ }
      }
      st.readyAt = clock();
      Object.assign(cloneInfo, { rel, rot: rel === "same" ? 0 : null });
      // a swapped clone is used only once its rotation is known (verifyClone, on the next frames)
      if (rel === "same") Object.assign(st, { state: "ready", rot: 0, key: `${cw}x${ch}/${vw2}x${vh2}` });
      else Object.assign(st, { state: "verify", tries: 0, nextTry: 0 });
    } catch (e) {
      if (cl === st) offClone(e?.why || "error");
      else stopClone(st);
    }
  }

  function stopClone(st) {
    try { st?.track?.stop(); } catch { /* ignore */ }
    if (st) { st.track = null; st.state = "off"; }
  }

  // the clone path failed: back to the video for good, the reason in grabInfo().why
  function offClone(why) {
    const st = cl;
    stopClone(st);
    try { if (cloneVideo) { cloneVideo.pause?.(); cloneVideo.srcObject = null; } } catch { /* ignore */ }
    if (why === "orig-changed") {
      // restore the camera's size if the clone's constraints moved it (a browser without per-track scaling)
      const w0 = cloneInfo.ow0, h0 = cloneInfo.oh0;
      if (w0 && h0 && camTrack?.applyConstraints) camTrack.applyConstraints({ width: { ideal: w0 }, height: { ideal: h0 } }).catch(() => {});
    }
    if (why !== "closed") {
      pathWhy = `clone:${why}`;
      if (path === "clone") path = "main";
    }
  }

  const detectSafe = (img, po) => { try { return detect(img, po); } catch { return { found: false, weak: false, corners: null }; } };

  /** One frame, all on the calling thread. */
  function analyze(now = clock()) {
    startClone();
    const g = grab();
    if (!g) return null;
    const po = prior.opts(g.W, g.H), td = clock();
    const r = detectSafe(g.img, po);
    const detectMs = clock() - td;
    const tk = trackStep(g, r, now);
    return complete(g, po, r, now, tk, detectMs, 0);
  }

  // the clone path is chosen on the first frame (it needs no worker) and set up in the background;
  // until it is ready the frames come from the video
  function startClone() {
    if (path !== null || !(framePref === "clone" || (framePref === "auto" && chromium))) return;
    if (!canClone()) { path = "main"; pathWhy = "clone:unsupported"; return; }
    path = "clone";
    attachClone();
  }

  const canTrack = () => typeof globalThis.MediaStreamTrackProcessor === "function" && Boolean(camTrack) && camTrack.readyState !== "ended"
    && Boolean(detectWorker?.encoder);
  const canBitmap = () => typeof globalThis.createImageBitmap === "function" && Boolean(detectWorker?.encoder);

  function choosePath() {
    const want = framePref;
    if (want === "track") return canTrack() ? "track" : canBitmap() ? "bitmap" : "main";
    if (want === "bitmap") return canBitmap() ? "bitmap" : "main";
    return "main";
  }

  // a frame path that failed: track -> bitmap -> main, for good
  function demote(why) {
    pathWhy = `${path}:${why}`;
    if (path === "track") {
      attached = null;
      detectWorker?.call("detach").catch(() => {});
      path = canBitmap() ? "bitmap" : "main";
    } else path = "main";
  }

  // Attach the camera track to the detect worker once (Chrome: MediaStreamTrackProcessor on the page,
  // its readable transferred). The page never sees those frames.
  async function attach() {
    attached = "pending";
    const proc = new globalThis.MediaStreamTrackProcessor({ track: camTrack });
    await detectWorker.call("attach", { readable: proc.readable }, [proc.readable]);
    attached = "yes";
    attachedAt = clock();
  }

  // createImageBitmap's synchronous part is the page's cost (Chrome scales a video frame there on the GPU)
  async function bitmapOf(rect, dw, dh) {
    const t = clock();
    const p = rect
      ? createImageBitmap(video, rect.x, rect.y, rect.w, rect.h, { resizeWidth: dw, resizeHeight: dh, resizeQuality: "low" })
      : createImageBitmap(video, { resizeWidth: dw, resizeHeight: dh, resizeQuality: "low" });
    const syncMs = clock() - t;
    const bmp = await p;
    return { bmp, syncMs, waitMs: clock() - t - syncMs };
  }

  /**
   * Regions of the current camera frame read by the frame path (probe crops, glare): rects [{x, y, w,
   * h (video px), dw, dh (read size)}] -> RGBA images, or null on the main path / without a frame.
   */
  async function crop(rects) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !detectWorker?.available()) return null;
    if (path === "track" && attached === "yes") {
      const out = await detectWorker.call("crop", { rects, vw, vh });
      return out?.imgs || null;
    }
    if (path === "bitmap") {
      const bitmaps = [];
      try {
        for (const r of rects) bitmaps.push((await bitmapOf(r, r.dw, r.dh)).bmp);
      } catch (e) { for (const b of bitmaps) b.close?.(); throw e; }
      const out = await detectWorker.call("cropBitmaps", { bitmaps }, bitmaps);
      return out?.imgs || null;
    }
    return null;
  }

  /**
   * One frame with detect() in the detect worker (opts.detectWorker, a createScanWorker client) when
   * it is ready, else analyze(). On the main path the frame's pixels travel to the worker and back
   * (transferred, no copy); on the track / bitmap paths the worker reads the frame itself and sends
   * the 480 px pixels back. The tracker, prior and thumbnails stay here. Resolves null when the worker
   * failed with this frame or had no new frame yet (the next frame runs as usual).
   */
  async function analyzeAsync(now = clock()) {
    if (!detectWorker || !detectWorker.available()) return analyze(now);
    startClone();
    if (path === null) path = choosePath();
    if (path === "track") {
      if (attached === null) {
        try { await attach(); } catch { demote("attach"); }
        return null;
      }
      if (attached === "pending") return null;
      return analyzeFrame(now, "track");
    }
    if (path === "bitmap") return analyzeFrame(now, "bitmap");
    const g = grab();
    if (!g) return null;
    const po = prior.opts(g.W, g.H), td = clock();
    let out;
    try { out = await detectWorker.call("detect", { img: g.img, opts: po }, [g.img.d.buffer]); } catch { return null; }
    const wait = clock() - td;
    g.img = { w: g.W, h: g.H, d: out.d };
    const tk = trackStep(g, out.r, now);
    return complete(g, po, out.r, now, tk, Number.isFinite(out.ms) ? out.ms : wait, wait);
  }

  // track / bitmap path: the worker reads the frame
  async function analyzeFrame(now, kind) {
    const t0 = clock();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const { W, H, s } = workSize(vw, vh, workShort);
    const po = prior.opts(W, H);
    let out, wait = 0, grabMs = 0;
    try {
      if (kind === "track") {
        const tw = clock();
        out = await detectWorker.call("frame", { W, H, vw, vh, opts: po, ...frameOpts });
        wait += clock() - tw;
        if (out.none) {
          if (!out.frames && clock() - attachedAt > 3000) demote("no-frames");
          return null;
        }
      } else {
        const b = await bitmapOf(null, W, H);
        grabMs = b.syncMs;
        wait += b.waitMs;
        const tw = clock();
        out = await detectWorker.call("frameBitmap", { bitmap: b.bmp, opts: po, ...frameOpts }, [b.bmp]);
        wait += clock() - tw;
      }
    } catch (e) {
      if (/orientation/.test(String(e?.message))) demote("orientation");
      else if (kind === "bitmap" && !/scan worker/.test(String(e?.message))) demote("bitmap");
      return null;
    }
    wgrabMode = out.mode || wgrabMode;
    const g = { vw, vh, W, H, s, img: { w: W, h: H, d: out.d }, t0, grabMs, mode: kind, wgrab: out.grabMs };
    work = null;
    workImg = g.img;
    const tk = trackStep(g, out.r, now);
    return complete(g, po, out.r, now, tk, out.ms, wait);
  }

  // tracker + prior for a detected frame: {tr, tracked, trackedV}
  function trackStep(g, r, now) {
    prior.noteFrame(r);
    const tr = tracker.update(r);
    if (tr.stable && !wasStable) {
      runId++;
      stableSince = now;
      if (!prior.active && tr.corners) prior.observe(tr.corners, g.W, g.H);
    }
    wasStable = Boolean(tr.stable);
    const tracked = Boolean(tr.corners && tr.seen && tr.found);
    return { tr, tracked, trackedV: tracked ? toVideo(tr.corners, g.s) : null };
  }

  // blank/seen + glare + thumbnails + the FrameAnalysis
  function complete(g, po, r, now, tk, detectMs, waitMs) {
    const { vw, vh, W, H, s, img } = g;
    const { tr, tracked, trackedV } = tk;
    // strip sharpness on the work frame (stripSharpness; no camera-frame read). 0 when the strip lies
    // outside the frame: that is no measurement, not a blank card
    const ts = clock();
    let sharp = null;
    if (tracked) { try { sharp = stripSharpness(img, tr.corners); } catch { sharp = null; } }
    const sharpMs = clock() - ts;
    const blank = tracked && Number.isFinite(sharp) && sharp > 0 && sharp < blankSharp;
    const seen = tracked && !blank;
    const corners = seen ? trackedV : null;
    const stable = Boolean(seen && tr.stable);
    if (!seen) glare = noGlare();
    else if (glareOn && stable && now - stableSince >= glareDelayMs && now - glareAt >= glareEveryMs) {
      glareAt = now;
      // the stable-track hint keeps the beta.2 limits (typeLine only for failed probes, see glareOf);
      // on the clone path it is measured on the work frame (a 4K read every 1.5 s would cost more
      // than the clone saves)
      const fromWork = g.src === "clone";
      if (pixels && pixels.available()) {
        if (!glarePending) requestGlare(corners, fromWork ? { img: { w: img.w, h: img.h, d: new Uint8ClampedArray(img.d) }, q: tr.corners } : null);
      } else {
        try {
          const card = fromWork ? warpQuad(img, tr.corners, 500, 700) : rectify(corners, 500, 500, 700);
          if (card) {
            const gm = glareMap(card), code = captureAdvice(gm, null, { typeLine: Infinity });
            glare = { advice: code === "ok" ? null : ADVICE_HINTS[code], code, regions: gm.regions };
          }
        } catch { /* glare is advisory only */ }
      }
    }
    const pq = (po.prior && po.prior.quad) || prior.learnedQuad(W, H);
    last = { W, H, s, tr, seen, mode: r.mode || "free", runId };
    const total = clock() - g.t0;
    return {
      vw, vh, found: seen, weak: Boolean(seen && !tr.accepted), accepted: Boolean(seen && tr.accepted), stable,
      corners, rawCorners: r.corners ? toVideo(r.corners, s) : null,
      jitter: Number.isFinite(tr.jitter) ? tr.jitter : null, drift: Number.isFinite(tr.drift) ? tr.drift : null,
      mode: r.mode || "free", score: Number.isFinite(r.score) ? r.score : null,
      orientConf: Number.isFinite(r.orientConf) ? r.orientConf : null,
      thumb: frameThumb(img), cardThumb: seen ? quadThumb(img, tr.corners) : null,
      sharp, blank, glare, priorQuad: pq ? toVideo(pq, s) : null, priorLearned: Boolean(prior.active),
      now, ms: total,
      // main-thread ms (total minus the waits for the workers), per step (grab: this thread's frame
      // read; sharp: the work-frame strip sharpness; wgrab: the worker's frame read), and how the frame
      // was read (path 'clone' only for a frame drawn from the clone)
      timing: {
        main: r1(total - waitMs), grab: r1(g.grabMs), detect: r1(detectMs), sharp: r1(sharpMs), mode: g.mode, worker: waitMs > 0,
        path: g.mode === "track" || g.mode === "bitmap" ? g.mode : g.src === "clone" ? "clone" : "main",
        wgrab: Number.isFinite(g.wgrab) ? r1(g.wgrab) : null,
      },
    };
  }

  /**
   * Glare of the card at `quad` (video px) in the current video frame, for a probe crop: {code,
   * advice (hint text | null), regions (rounded fractions), fraction}, or null when it can't be measured.
   * ~45 ms on a desktop CPU: the UI runs it while the probe request is in flight.
   */
  function glareOf(quad) {
    if (!quad) return null;
    try {
      const card = rectify(quad, 500, 500, 700);
      if (!card) return null;
      return glareSummary(glareMap(card));
    } catch { return null; }
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
    glare = noGlare(); glareAt = -Infinity; stableSince = null; runId++;
    loadPrior();
  }

  /** Forget the learned box on this device. */
  function forgetPrior() {
    prior.forget();
    try { storage?.removeItem(PRIOR_STORAGE_KEY); } catch { /* ignore */ }
  }

  /** captureCard/grabStill options: the video frame while the box prior is active (corners exact), else takePhoto + A2 re-detect. */
  function captureOpts() {
    return { preferPhoto: !prior.active };
  }

  // the work frame as a canvas: the main path's work canvas, else a canvas of the worker's pixels
  // (a fresh one per call, so it stays the frame of the call)
  function workCanvas() {
    if (work) return work;
    if (!workImg || typeof ImageData !== "function") return null;
    try {
      const c = mk(workImg.w, workImg.h);
      ctx2d(c).putImageData(new ImageData(asClamped(workImg.d), workImg.w, workImg.h), 0, 0);
      return c;
    } catch { return null; }
  }

  /** The last analysed work frame (480 px short side) as base64 JPEG (record session), or null. */
  function frameJpeg(quality = 0.7) {
    const c = workCanvas();
    if (!c || typeof c.toDataURL !== "function") return null;
    const url = c.toDataURL("image/jpeg", quality);
    return url.slice(url.indexOf(",") + 1);
  }

  /**
   * frameJpeg without blocking: canvas.toBlob (the pixels are taken at call time). With
   * `fallback`, a JPEG longer than `maxLen` base64 chars is encoded again at that quality from a
   * copy taken now (the analysis loop redraws the work canvas meanwhile, and the record session's
   * frame must stay the frame of its record); null when it is still too long.
   */
  function frameJpegAsync(quality = 0.7, { fallback = null, maxLen = Infinity } = {}) {
    const c = workCanvas();
    if (!c) return Promise.resolve(null);
    let snap = null;
    if (fallback != null) {
      if (c !== work) snap = c;
      else {
        try {
          snap = mk(c.width, c.height);
          snap.getContext("2d").drawImage(c, 0, 0, c.width, c.height);
        } catch { snap = null; }
      }
    }
    return canvasJpeg(c, quality)
      .then((j) => (j && j.length > maxLen && snap ? canvasJpeg(snap, fallback) : j))
      .then((j) => (j && j.length > maxLen ? null : j))
      .catch(() => null);
  }

  /**
   * How the work frame is read: {path ('main'|'clone'|'track'|'bitmap'; null before the first frame
   * picked one), why (the path that failed, e.g. 'clone:not-scaled', 'track:orientation'), mode
   * ('cpu'|'gpu'|null while timing both: the page's canvas), pref, cpu/gpu (median ms of the video
   * reads per canvas), wmode (the worker's canvas), clone (null unless tried: {state, w, h (the clone
   * video), ask_w/ask_h (asked, track convention), set_w/set_h/resize (its settings), ow0/oh0 and
   * ow1/oh1 (the original track's size before / after the clone started), setup_ms, frames, rel
   * ('same'|'swapped'), rot (clockwise degrees the clone is drawn turned; null while unknown), rot_score /
   * rot_margin / rot_tries / rot_why (the rotation check of a swapped clone)})}.
   */
  function grabInfo() {
    const m = (a) => (a.length > GRAB_WARM ? r1(median(a.slice(GRAB_WARM))) : null);
    const clone = cl ? { state: cl.state, ...cloneInfo, frames: cl.frames } : null;
    return { path, why: pathWhy, mode: grabMode, pref: grabPref, cpu: m(grabTrials.cpu), gpu: m(grabTrials.gpu), wmode: wgrabMode, clone };
  }

  /** Stop the frame path (the camera stops or the analyzer is dropped): the worker's track, the clone. */
  function close() {
    if (attached) detectWorker?.call("detach").catch(() => {});
    attached = null;
    if (cl) {
      const st = cl;
      cl = { ...st, track: null, state: "off" };
      stopClone(st);
      try { if (cloneVideo) { cloneVideo.pause?.(); cloneVideo.srcObject = null; } } catch { /* ignore */ }
    }
  }

  loadPrior();
  return {
    analyze, analyzeAsync, prior, tracker, reset, glareOf, savePrior, loadPrior, forgetPrior, captureOpts, frameJpeg, frameJpegAsync,
    grabInfo, crop, close, get path() { return path; },
  };
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

/**
 * Per-region glare fraction that blocks a capture (research values; G3 validates them). typeLine
 * (beta.5): the free-hand recording's lamp reflections on foils sat on the art or the type line.
 */
export const ADVICE_LIMITS = Object.freeze({ collector: 0.004, title: 0.02, art: 0.05, typeLine: 0.1, sharpFloor: 60 });

export const ADVICE_HINTS = Object.freeze({
  ok: "",
  "glare-collector": "Reflection on the bottom line: tilt slightly",
  "glare-title": "Reflection on the name: tilt slightly",
  "glare-art": "Reflection on the picture: tilt slightly",
  "glare-type": "Reflection in the middle of the card: tilt slightly",
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
 * @returns {'ok'|'glare-collector'|'glare-title'|'glare-art'|'glare-type'|'too-blurry'} (hint: ADVICE_HINTS[code])
 */
export function captureAdvice(glare, sharpness, limits = {}) {
  const L = { ...ADVICE_LIMITS, ...limits };
  if (Number.isFinite(sharpness) && sharpness < L.sharpFloor) return "too-blurry";
  const r = glare?.regions ?? {};
  if ((r.collector ?? 0) > L.collector) return "glare-collector";
  if ((r.title ?? 0) > L.title) return "glare-title";
  if ((r.art ?? 0) > L.art) return "glare-art";
  if ((r.typeLine ?? 0) > L.typeLine) return "glare-type";
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
