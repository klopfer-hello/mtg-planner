// scanworker.js: the scanner's pixel work off the main thread (module worker).
//
// Why it exists: on a Pixel 9 the scanner froze the page. Per frame, detect()
// ran on the main thread, and per probe the 1000x1400 perspective warp, two
// synchronous JPEG encodes and a second warp + glare map blocked it for about
// 0.5 s (headless Chromium at 4x CPU throttling). scanlib.js createScanWorker
// is the client and falls back to the same code inline when this worker can't
// load.
//
// Camera frames (Pixel 9 beacon, 0.6.2-beta.1: reading the 4K frame on the
// main thread took ~230 ms for the 480 px work frame plus ~220 ms for the strip
// sharpness, GPU -> CPU readback): where the page can, the frames are read here
// instead. 'attach' takes a MediaStreamTrackProcessor's readable (Chrome: the
// page never touches the 4K frame; the newest VideoFrame is kept, the rest are
// closed), the *Bitmap ops take ImageBitmaps the page cut and scaled with
// createImageBitmap (no readback on the page).
//
// Ops (one job at a time, in order):
//   detect {img, opts}             -> {r (detect() result), d (the pixels back), ms}
//   probe {card, strip, glare}     -> {card, strip} base64 JPEGs (OffscreenCanvas), or
//                                     {raw: true, card, strip} RGBA when the worker can't encode
//   glareLast {limits?}            -> glareSummary of the last probe card (null when none)
//   glare {img, q, outW, outH, limits?} -> glareSummary of the warped card
//   attach {readable}              -> {ok}: read VideoFrames from now on
//   detach                         -> {ok}: stop reading, close the frames
//   frame {W, H, vw, vh, opts, mode?} -> the newest frame at W x H + detect(): {r, d, ms, grabMs, mode,
//                                     fw, fh, frames} | {none: true} (no new frame yet); error
//                                     'orientation' when the frame is not upright like the video
//   frameBitmap {bitmap, opts, mode?} -> the same for an ImageBitmap the page scaled
//   sharp {rect, dw, dh, vw, vh}   -> {sharp}: Laplacian variance of rect (video px) of the frame
//                                     the last 'frame' analysed, read at dw x dh
//   sharpBitmap {bitmap}           -> {sharp} of a scaled strip ImageBitmap
//   crop {rects[{x, y, w, h, dw, dh}], vw, vh} -> {imgs: RGBA[] | null} of the newest frame
//   cropBitmaps {bitmaps}          -> {imgs: RGBA[]}
//   grabInfo                       -> {mode, cpu, gpu (median ms), frames, attached}

import { detect } from './det/detect.mjs';
import { bytesToBase64, glareMap, glareSummary, laplacianVariance, toGray, warpQuad } from './scanlib.js';

const encoder = (() => {
  try {
    return typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
      && Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
  } catch { return false; }
})();

const rgba = (o) => ({ w: o.w, h: o.h, d: o.d instanceof Uint8ClampedArray ? o.d : new Uint8ClampedArray(o.d.buffer ?? o.d) });

async function encode(img, quality) {
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext('2d').putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Frame reading. 'gpu' = an accelerated canvas (the GPU scales the camera frame and only the
// small result is read back), 'cpu' = willReadFrequently (software). Unless the page fixes the
// mode, the first frames time both and keep the faster one (gpu only when clearly faster).

const now = () => performance.now();
const mkCanvas = (w, h) => (self.__mkCanvas ? self.__mkCanvas(w, h) : new OffscreenCanvas(w, h));
const ctxOf = (c, mode) => c.getContext('2d', { willReadFrequently: mode !== 'gpu' });
const canvases = new Map();
function cachedCtx(kind, mode, w, h) {
  const key = `${kind}:${mode}`;
  let e = canvases.get(key);
  if (!e || e.c.width !== w || e.c.height !== h) {
    const c = mkCanvas(w, h);
    e = { c, x: ctxOf(c, mode) };
    canvases.set(key, e);
  }
  return e.x;
}
const TRIALS = 6, WARM = 2, trials = { cpu: [], gpu: [] };
let grabMode = null;
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : Infinity; };
function pickMode(fixed) {
  if (fixed === 'cpu' || fixed === 'gpu') return fixed;
  if (grabMode) return grabMode;
  const { cpu, gpu } = trials;
  if (cpu.length >= TRIALS + WARM && gpu.length >= TRIALS + WARM) {
    grabMode = median(gpu.slice(WARM)) < 0.85 * median(cpu.slice(WARM)) ? 'gpu' : 'cpu';
    return grabMode;
  }
  return cpu.length <= gpu.length ? 'cpu' : 'gpu';
}

/** src (VideoFrame / ImageBitmap) region `rect` (its px, null = all) read at dw x dh: RGBA. */
function read(x, src, rect, dw, dh) {
  if (rect) x.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh);
  else x.drawImage(src, 0, 0, dw, dh);
  return { w: dw, h: dh, d: x.getImageData(0, 0, dw, dh).data };
}

let reader = null, latest = null, held = null, frames = 0;
const closeFrame = (f) => { try { f?.close?.(); } catch { /* ignore */ } };

async function pump(r) {
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      if (reader !== r) { closeFrame(value); break; }
      if (latest) closeFrame(latest);
      latest = value;
      frames++;
    }
  } catch { /* the track ended or the stream was cancelled */ }
}

/** The frame's size; throws 'orientation' when it is not upright like the video (rotated/flipped). */
function frameDims(f, vw, vh) {
  const fw = f.displayWidth ?? f.width, fh = f.displayHeight ?? f.height;
  if ((f.rotation || 0) !== 0 || f.flip || !(fw > 0 && fh > 0) || (fw > fh) !== (vw > vh)) throw new Error('orientation');
  return { fw, fh };
}

const scaleRect = (r, kx, ky) => ({ x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky });

function detectOn(img, opts) {
  const t0 = now();
  const r = detect(img, opts || {});
  delete r.dbg; delete r.dbgT;
  return { r, ms: now() - t0 };
}

function analyseRead(src, rect, W, H, opts, mode) {
  const m = pickMode(mode), t0 = now();
  const img = read(cachedCtx('work', m, W, H), src, rect, W, H);
  const grabMs = now() - t0;
  if (!grabMode && mode !== 'cpu' && mode !== 'gpu') trials[m].push(grabMs);
  const { r, ms } = detectOn(img, opts);
  return { r, d: img.d, ms, grabMs, mode: m };
}

let lastCard = null;

const ops = {
  detect({ img, opts }) {
    const im = rgba(img);
    const { r, ms } = detectOn(im, opts);
    return { result: { r, d: im.d, ms }, transfer: [im.d.buffer] };
  },
  async probe({ card, strip, glare }) {
    const c = warpQuad(rgba(card.img), card.q, card.outW, card.outH);
    const s = warpQuad(rgba(strip.img), strip.q, strip.outW, strip.outH);
    lastCard = glare ? c : null;
    if (!encoder) {
      const cc = glare ? { w: c.w, h: c.h, d: c.d.slice() } : c;
      return { result: { raw: true, card: cc, strip: s }, transfer: [cc.d.buffer, s.d.buffer] };
    }
    const cardB64 = await encode(c, card.quality);
    const stripB64 = await encode(s, strip.quality);
    return { result: { card: cardB64, strip: stripB64 } };
  },
  glareLast({ limits }) {
    const c = lastCard;
    lastCard = null;
    return { result: c ? glareSummary(glareMap(c), limits) : null };
  },
  glare({ img, q, outW, outH, limits }) {
    const card = warpQuad(rgba(img), q, outW, outH);
    return { result: glareSummary(glareMap(card), limits) };
  },
  attach({ readable }) {
    ops.detach();
    reader = readable.getReader();
    pump(reader);
    return { result: { ok: true } };
  },
  detach() {
    const r = reader;
    reader = null;
    try { r?.cancel().catch(() => {}); } catch { /* ignore */ }
    closeFrame(latest);
    closeFrame(held);
    latest = held = null;
    return { result: { ok: true } };
  },
  frame({ W, H, vw, vh, opts, mode }) {
    // the newest frame becomes the analysed one ('sharp' reads it; held until the next one)
    if (!latest) return { result: { none: true, frames } };
    closeFrame(held);
    held = latest;
    latest = null;
    const { fw, fh } = frameDims(held, vw, vh);
    const out = analyseRead(held, null, W, H, opts, mode);
    return { result: { ...out, fw, fh, frames }, transfer: [out.d.buffer] };
  },
  frameBitmap({ bitmap, opts, mode }) {
    try {
      const out = analyseRead(bitmap, null, bitmap.width, bitmap.height, opts, mode);
      return { result: out, transfer: [out.d.buffer] };
    } finally { bitmap.close?.(); }
  },
  sharp({ rect, dw, dh, vw, vh }) {
    if (!held) return { result: { sharp: null } };
    const { fw, fh } = frameDims(held, vw, vh);
    const img = read(cachedCtx('strip', grabMode || 'cpu', dw, dh), held, scaleRect(rect, fw / vw, fh / vh), dw, dh);
    return { result: { sharp: laplacianVariance(toGray(img)) } };
  },
  sharpBitmap({ bitmap }) {
    try {
      const { width: w, height: h } = bitmap;
      return { result: { sharp: laplacianVariance(toGray(read(cachedCtx('strip', grabMode || 'cpu', w, h), bitmap, null, w, h))) } };
    } finally { bitmap.close?.(); }
  },
  crop({ rects, vw, vh }) {
    const f = latest || held;
    if (!f) return { result: { imgs: null } };
    const { fw, fh } = frameDims(f, vw, vh);
    // one-off reads (probe / glare crops): a fresh canvas each, the cached ones keep their sizes
    const imgs = rects.map((r) => read(ctxOf(mkCanvas(r.dw, r.dh), grabMode || 'cpu'), f, scaleRect(r, fw / vw, fh / vh), r.dw, r.dh));
    return { result: { imgs }, transfer: imgs.map((i) => i.d.buffer) };
  },
  cropBitmaps({ bitmaps }) {
    try {
      const imgs = bitmaps.map((b) => read(ctxOf(mkCanvas(b.width, b.height), 'cpu'), b, null, b.width, b.height));
      return { result: { imgs }, transfer: imgs.map((i) => i.d.buffer) };
    } finally { for (const b of bitmaps) b.close?.(); }
  },
  grabInfo() {
    const m = (a) => (a.length > WARM ? Math.round(median(a.slice(WARM)) * 10) / 10 : null);
    return { result: { mode: grabMode, cpu: m(trials.cpu), gpu: m(trials.gpu), frames, attached: Boolean(reader) } };
  },
};

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data || {};
  chain = chain.then(async () => {
    try {
      const op = ops[m.op];
      if (!op) throw new Error(`unknown op ${m.op}`);
      const { result, transfer = [] } = await op(m);
      self.postMessage({ id: m.id, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: String(err?.message || err) });
    }
  });
};

self.postMessage({ ready: true, encoder });
