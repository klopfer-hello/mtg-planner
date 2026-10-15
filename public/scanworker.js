// scanworker.js: the scanner's pixel work off the main thread (module worker).
//
// Why it exists: on a Pixel 9 the scanner froze the page. Per frame, detect()
// ran on the main thread, and per probe the 1000x1400 perspective warp, two
// synchronous JPEG encodes and a second warp + glare map blocked it for about
// 0.5 s (headless Chromium at 4x CPU throttling). The page now only reads the
// pixels (drawImage + getImageData) and hands them over here (transferred, not
// copied); scanlib.js createScanWorker is the client and falls back to the
// same code inline when this worker can't load.
//
// Ops (one job at a time, in order):
//   detect {img, opts}             -> {r (detect() result), d (the pixels back), ms}
//   probe {card, strip, glare}     -> {card, strip} base64 JPEGs (OffscreenCanvas), or
//                                     {raw: true, card, strip} RGBA when the worker can't encode
//   glareLast {limits?}            -> glareSummary of the last probe card (null when none)
//   glare {img, q, outW, outH, limits?} -> glareSummary of the warped card

import { detect } from './det/detect.mjs';
import { bytesToBase64, glareMap, glareSummary, warpQuad } from './scanlib.js';

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

let lastCard = null;

const ops = {
  detect({ img, opts }) {
    const im = rgba(img), t0 = performance.now();
    const r = detect(im, opts || {});
    delete r.dbg; delete r.dbgT;
    return { result: { r, d: im.d, ms: performance.now() - t0 }, transfer: [im.d.buffer] };
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
