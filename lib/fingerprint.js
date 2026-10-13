// Perceptual card fingerprints for the scanner (server side only).
//
// Method (measured in the matching-robustness research on synthetic phone
// captures: printing top-1 ≈ .97, artwork top-1 ≈ .995): three dHashes per
// card face, 88 bytes in total —
//   words  0– 7  gray dHash 256 (17×16) of the full card, inset 3%
//   words  8–15  gray dHash 256 (17×16) of the art box x .12–.88, y .13–.52
//   words 16–21  colour dHash 3×64 (9×8 per R, G, B) of the full card inset
// The score is the mean of the three normalised Hamming distances. Queries
// are hashed at 27 shift/scale variants (±2% shift, scale .97/1/1.03) and each
// reference takes its minimum over the variants, which absorbs corner error
// from the browser's perspective warp. Resampling is area-average, implemented
// once here, because toolchain resampling differences alone cost 2–10 bits.
//
// JPEG decoding uses `djpeg` (libjpeg-turbo-progs): Scryfall images are all
// progressive JPEGs, Node can't decode JPEG, and the project takes no npm
// runtime dependencies. The reference index is built in the background from
// Scryfall "small" images (146×204, accuracy equal to "normal"), one hash per
// (illustration, frame, border, full-art, frame effects) group, never from
// placeholder or missing images.

import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getMeta, setMeta } from "./cardindex.js";

export const FP_BYTES = 88;
const WORDS = FP_BYTES / 4;
const BOX = { full: [0.03, 0.03, 0.97, 0.97], art: [0.12, 0.13, 0.88, 0.52] };
const SHIFTS = [-0.02, 0, 0.02];
const SCALES = [0.97, 1, 1.03];
// Larger inputs are area-downscaled to this size once before the 27 variants.
const QUERY_W = 488;
const QUERY_H = 680;
const USER_AGENT = process.env.SCRYFALL_USER_AGENT || "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)";

// --- decoding --------------------------------------------------------------

let djpegOk = null;
/** True when the `djpeg` binary is installed. */
export function hasDjpeg() {
  if (djpegOk === null) {
    const r = spawnSync("djpeg", ["-version"], { stdio: "ignore" });
    djpegOk = !r.error;
  }
  return djpegOk;
}

/** Parse a binary PGM (P5) / PPM (P6) buffer with maxval 255. */
export function parsePnm(buf) {
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; } // # comment
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString("latin1", start, pos);
  };
  const magic = token();
  if (magic !== "P5" && magic !== "P6") throw new Error(`unsupported PNM ${magic}`);
  const width = parseInt(token(), 10);
  const height = parseInt(token(), 10);
  const maxval = parseInt(token(), 10);
  if (!(width > 0 && height > 0) || maxval !== 255) throw new Error("bad PNM header");
  pos++; // single whitespace after maxval
  const channels = magic === "P6" ? 3 : 1;
  const len = width * height * channels;
  if (buf.length - pos < len) throw new Error("truncated PNM");
  return { width, height, channels, data: new Uint8Array(buf.buffer, buf.byteOffset + pos, len) };
}

/** Default pixel cap for decoding (a phone strip is ~1-3 MP, a rectified card 1.4 MP). */
export const MAX_DECODE_PIXELS = 24_000_000;

/**
 * Width/height from a JPEG's SOFn header without decoding it, or null when
 * there is none. djpeg writes the full declared raster even for a truncated
 * file, so callers check this before spawning it (a 600-byte JPEG can claim
 * 40000x40000 pixels).
 */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Throw unless `buf` is a JPEG whose declared size is at most maxPixels. Returns {width, height}. */
export function checkJpegSize(buf, maxPixels = MAX_DECODE_PIXELS) {
  const size = jpegSize(buf);
  if (!size || !size.width || !size.height) throw Object.assign(new Error("not a JPEG image (no frame header)"), { code: "BAD_JPEG" });
  if (size.width * size.height > maxPixels) {
    throw Object.assign(new Error(`JPEG is too large (${size.width}x${size.height}, max ${maxPixels} pixels)`), { code: "BAD_JPEG" });
  }
  return size;
}

/**
 * Decode a JPEG (baseline or progressive) by piping it through `djpeg -pnm`.
 * Options: gray (decode to one channel), scale ("1/2", "1/4", "1/8"),
 * nice (lower the child's CPU priority), maxPixels (declared size cap; the
 * output is also cut off at the expected raster size). Returns {width, height, channels, data}.
 */
export function decodeJpeg(buf, { gray = false, scale, nice = false, timeoutMs = 15000, maxPixels = MAX_DECODE_PIXELS } = {}) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = checkJpegSize(buf, maxPixels); } catch (e) { return reject(e); }
    const maxBytes = size.width * size.height * (gray ? 1 : 3) + 1024;
    const args = ["-pnm"];
    if (gray) args.push("-grayscale");
    if (scale) args.push("-scale", scale);
    const child = spawn("djpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    if (nice) { try { os.setPriority(child.pid, 15); } catch { /* best effort */ } }
    const out = [];
    let outBytes = 0;
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > maxBytes) { err = "output larger than the declared image"; child.kill("SIGKILL"); return; }
      out.push(d);
    });
    child.stderr.on("data", (d) => { if (err.length < 500) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.on("error", () => { /* EPIPE when djpeg rejects input early */ });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`djpeg exited ${code}: ${err.trim().slice(0, 200)}`));
      try { resolve(parsePnm(Buffer.concat(out))); } catch (e) { reject(e); }
    });
    child.stdin.end(buf);
  });
}

// --- resampling and hashing --------------------------------------------------

/**
 * Area-average resample of the fractional region [x0,y0,x1,y1] of `img` to
 * ow×oh. Out-of-range source pixels clamp to the edge. Returns Float32 RGB.
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

const toGray = (p) => {
  const o = new Float32Array(p.length / 3);
  for (let i = 0; i < o.length; i++) o[i] = 0.299 * p[i * 3] + 0.587 * p[i * 3 + 1] + 0.114 * p[i * 3 + 2];
  return o;
};

// dHash: bit set when a pixel is darker than its right neighbour; (w-1)*h bits
// written into `u` starting at bit `bit`.
function dhashInto(u, bit, px, w, h, stride = 1, off = 0) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++, bit++) {
      if (px[(y * w + x) * stride + off] < px[(y * w + x + 1) * stride + off]) u[bit >> 5] |= 1 << (bit & 31);
    }
  }
  return bit;
}

const variantBox = (b, dx, dy, sc) => {
  const cx = (b[0] + b[2]) / 2 + dx, cy = (b[1] + b[3]) / 2 + dy;
  const hw = ((b[2] - b[0]) / 2) * sc, hh = ((b[3] - b[1]) / 2) * sc;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
};

function hashAt(img, dx = 0, dy = 0, sc = 1) {
  const u = new Uint32Array(WORDS);
  const full = variantBox(BOX.full, dx, dy, sc);
  dhashInto(u, 0, toGray(areaResample(img, full, 17, 16)), 17, 16);
  dhashInto(u, 256, toGray(areaResample(img, variantBox(BOX.art, dx, dy, sc), 17, 16)), 17, 16);
  const c = areaResample(img, full, 9, 8);
  let bit = 512;
  for (let ch = 0; ch < 3; ch++) bit = dhashInto(u, bit, c, 9, 8, 3, ch);
  return Buffer.from(u.buffer, u.byteOffset, FP_BYTES);
}

/** 88-byte reference fingerprint of a card image (decoded pixels, RGB or gray). */
export function hashCard(pixels) {
  return hashAt(pixels);
}

/** The query side: 27 shift/scale variants of a (rectified) card image. */
export function hashQuery(pixels) {
  let img = pixels;
  if (img.width > QUERY_W * 1.25 || img.height > QUERY_H * 1.25) {
    const rgb = areaResample(img, [0, 0, 1, 1], QUERY_W, QUERY_H);
    img = { width: QUERY_W, height: QUERY_H, channels: 3, data: rgb };
  }
  const out = [];
  for (const dx of SHIFTS) for (const dy of SHIFTS) for (const sc of SCALES) out.push(hashAt(img, dx, dy, sc));
  return out;
}

// --- distance -----------------------------------------------------------------

const pc = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};
const asWords = (h) => (h instanceof Uint32Array ? h : new Uint32Array(Uint8Array.from(h).buffer));

// Integer distance 3·full + 3·art + 4·colour; divide by 2304 for the 0..1 score.
const SCALE = 2304;

/** Normalised combined distance (0 = identical, ~0.5 = unrelated). */
export function score(a, b) {
  const A = asWords(a), B = asWords(b);
  let f = 0, r = 0, c = 0;
  for (let k = 0; k < 8; k++) f += pc((A[k] ^ B[k]) >>> 0);
  for (let k = 8; k < 16; k++) r += pc((A[k] ^ B[k]) >>> 0);
  for (let k = 16; k < 22; k++) c += pc((A[k] ^ B[k]) >>> 0);
  return (3 * f + 3 * r + 4 * c) / SCALE;
}

// --- matcher ------------------------------------------------------------------

/**
 * In-memory linear scan over all reference fingerprints (Uint32Array, SWAR
 * popcount). Reloads itself when the fingerprint job has added hashes.
 */
export class Matcher {
  constructor(idx) {
    this.idx = idx;
    this.words = new Uint32Array(0);
    this.meta = [];
    this.byKey = new Map();
    this.generation = null;
  }

  /** (Re)load every fingerprint from the index. Returns the count. */
  load() {
    const rows = this.idx.prepare(
      `SELECT f.key, f.hash, f.illustration_id, f.face, f.printing_id, p.oracle_id, p.name
       FROM fingerprints f LEFT JOIN printings p ON p.id = f.printing_id`,
    ).all();
    const words = new Uint32Array(rows.length * WORDS);
    const meta = new Array(rows.length);
    const byKey = new Map();
    rows.forEach((r, i) => {
      words.set(asWords(r.hash), i * WORDS);
      meta[i] = { key: r.key, printing_id: r.printing_id, face: r.face, illustration_id: r.illustration_id, oracle_id: r.oracle_id, name: r.name };
      byKey.set(r.key, i);
    });
    this.words = words;
    this.meta = meta;
    this.byKey = byKey;
    this.generation = getMeta(this.idx, "fp_generation");
    return rows.length;
  }

  get size() { return this.meta.length; }

  ensureLoaded() {
    const gen = getMeta(this.idx, "fp_generation");
    if (this.generation === null || gen !== this.generation) this.load();
  }

  // Minimum integer distance over query variants for every reference.
  scanAll(Q) {
    const N = this.meta.length, W = this.words, out = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      const o = i * WORDS;
      let m = 0xffff;
      for (let v = 0; v < Q.length; v++) {
        const q = Q[v];
        let s = 0;
        for (let k = 0; k < 8; k++) s += pc((q[k] ^ W[o + k]) >>> 0);
        s *= 3;
        if (s >= m) continue;
        let t = 0;
        for (let k = 8; k < 16; k++) t += pc((q[k] ^ W[o + k]) >>> 0);
        s += 3 * t;
        if (s >= m) continue;
        t = 0;
        for (let k = 16; k < 22; k++) t += pc((q[k] ^ W[o + k]) >>> 0);
        s += 4 * t;
        if (s < m) m = s;
      }
      out[i] = m;
    }
    return out;
  }

  printingsForKey(key) {
    return this.idx.prepare("SELECT printing_id FROM printing_fp WHERE key = ?").all(key).map((r) => r.printing_id);
  }

  /**
   * Top-K reference groups for the query variants, best first:
   * [{printing_id (the hashed representative), face, illustration_id,
   * oracle_id, name, key, score, printing_ids}]. `printing_ids` lists every
   * printing mapped to that fingerprint (other languages, same-frame reprints).
   * The returned array carries `bestOther` (best score with a different
   * oracle card than the top hit) for nameGap().
   */
  match(queryHashes, { topK = 20 } = {}) {
    this.ensureLoaded();
    const Q = queryHashes.map(asWords);
    const d = this.scanAll(Q);
    const order = [];
    for (let i = 0; i < d.length; i++) {
      if (order.length < topK) {
        order.push(i);
        if (order.length === topK) order.sort((a, b) => d[a] - d[b]);
      } else if (d[i] < d[order[topK - 1]]) {
        let j = topK - 1;
        while (j > 0 && d[order[j - 1]] > d[i]) { order[j] = order[j - 1]; j--; }
        order[j] = i;
      }
    }
    if (order.length < topK) order.sort((a, b) => d[a] - d[b]);
    const results = order.map((i) => ({
      ...this.meta[i],
      score: d[i] / SCALE,
      printing_ids: this.printingsForKey(this.meta[i].key),
    }));
    let bestOther = null;
    if (results.length) {
      const top = results[0];
      for (let i = 0; i < d.length; i++) {
        const m = this.meta[i];
        if (differentCard(m, top) && (bestOther === null || d[i] < bestOther)) bestOther = d[i];
      }
    }
    Object.defineProperty(results, "bestOther", { value: bestOther === null ? null : bestOther / SCALE, enumerable: false });
    return results;
  }

  /** Distance for specific printings (e.g. OCR or Claude candidates): Map id → {score, key}. */
  scorePrintings(queryHashes, printingIds) {
    this.ensureLoaded();
    const out = new Map();
    if (!printingIds?.length) return out;
    const Q = queryHashes.map(asWords);
    const rows = this.idx.prepare(
      `SELECT printing_id, key FROM printing_fp WHERE printing_id IN (${printingIds.map(() => "?").join(",")}) ORDER BY face`,
    ).all(...printingIds);
    for (const r of rows) {
      const i = this.byKey.get(r.key);
      if (i === undefined) continue;
      const ref = this.words.subarray(i * WORDS, (i + 1) * WORDS);
      let best = Infinity;
      for (const q of Q) best = Math.min(best, score(q, ref));
      const prev = out.get(r.printing_id);
      if (!prev || best < prev.score) out.set(r.printing_id, { score: best, key: r.key });
    }
    return out;
  }

  /**
   * Margin between the best hit and the best hit of a DIFFERENT card (by
   * oracle_id, else name). Uses the full-scan value from match() when present,
   * else the top-K list (a lower bound). null when there is nothing to compare.
   */
  nameGap(results) {
    if (!results?.length) return null;
    const d1 = results[0].score;
    if (results.bestOther != null) return results.bestOther - d1;
    const other = results.find((r) => differentCard(r, results[0]));
    return other ? other.score - d1 : null;
  }
}

function differentCard(a, b) {
  if (a.oracle_id && b.oracle_id) return a.oracle_id !== b.oracle_id;
  return (a.name || "") !== (b.name || "");
}

// --- background index build -----------------------------------------------------

const HASHABLE = ["highres_scan", "lowres"];
/**
 * Products that reuse a real card's illustration but are not that card (art
 * cards, Jumpstart front cards, tokens, emblems). They get their own groups,
 * so they never become the reference image (and oracle card) of the real one.
 */
export const NONCARD_LAYOUTS = Object.freeze(["art_series", "token", "double_faced_token", "emblem", "front_card"]);

/** Fingerprint group key: one hash per distinct look of an illustration. */
export function fingerprintKey(p, face, illustrationId) {
  const fx = (Array.isArray(p.frame_effects) ? p.frame_effects : JSON.parse(p.frame_effects || "[]")).slice().sort().join(",");
  const parts = [illustrationId || `${p.id}:${face}`, p.frame || "", p.border_color || "", p.full_art ? 1 : 0, fx];
  if (NONCARD_LAYOUTS.includes(p.layout)) parts.push(p.layout);
  return parts.join("|");
}

// Version of the key scheme + mapping; a change forces a re-map on resume.
const MAP_VERSION = 2;
const yieldNow = () => new Promise((res) => setImmediate(res));

// Faces that carry their own image (double-faced layouts) hash separately;
// everything else is face 0 with the top-level image.
function units(p) {
  const faces = typeof p.faces === "string" ? JSON.parse(p.faces || "[]") : p.faces || [];
  const own = faces.filter((f) => f.image_small);
  if (own.length) {
    return faces.map((f, i) => ({ face: i, illustration_id: f.illustration_id || p.illustration_id, url: f.image_small })).filter((u) => u.url);
  }
  return [{ face: 0, illustration_id: p.illustration_id, url: p.image_small }];
}

let agent = null;
function getAgent(concurrency) {
  if (!agent) agent = new https.Agent({ keepAlive: true, maxSockets: Math.max(1, concurrency) });
  return agent;
}

/** GET an image from cards.scryfall.io over a shared keep-alive agent. */
export function fetchImage(url, { concurrency = 2, timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: getAgent(concurrency),
      headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/*;q=0.8" },
      timeout: timeoutMs,
      signal,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchImage(new URL(res.headers.location, url).href, { concurrency, timeoutMs, signal }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error(`HTTP ${res.statusCode} for ${url}`);
        e.status = res.statusCode;
        return reject(e);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

function writeJob(idx, job) {
  job.updated_at = new Date().toISOString();
  setMeta(idx, "fingerprint_job", JSON.stringify(job));
}
const bumpGeneration = (idx) => setMeta(idx, "fp_generation", `${Date.now()}`);

/**
 * Build (or resume) the reference fingerprints in the background. Plans one
 * hash per fingerprint group (English, highres images preferred as the
 * representative), maps every printing in scope to its group, then fetches,
 * decodes and hashes the missing groups with `concurrency` (≤2) workers.
 * Progress lives in meta.fingerprint_job; already-hashed keys are skipped.
 * Options: signal, onProgress(job), concurrency, sets (array; default env
 * FP_INDEX_SETS), keepImages, imageDir, maxConsecutiveErrors (25), fetchImage/decode (test stubs).
 */
export async function buildFingerprints(idx, opts = {}) {
  const {
    signal,
    onProgress,
    concurrency: conc = 2,
    sets = (process.env.FP_INDEX_SETS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    keepImages = process.env.FP_KEEP_IMAGES !== "false",
    imageDir = process.env.FP_IMAGE_DIR || "/data/images",
    fetchImage: fetchImg = (url) => fetchImage(url, { concurrency, signal }),
    decode = (buf) => decodeJpeg(buf, { nice: true }),
    maxConsecutiveErrors = 25,
  } = opts;
  const concurrency = Math.min(2, Math.max(1, conc));
  const scoped = sets.length > 0;
  const setSql = scoped ? ` AND set_code IN (${sets.map(() => "?").join(",")})` : "";
  const job = {
    state: "running", phase: "plan", done: 0, total: 0, fetched: 0, errors: 0, last_error: null,
    sets: scoped ? sets : null, started_at: new Date().toISOString(),
  };
  writeJob(idx, job);
  onProgress?.(job);

  // 1. Plan representatives: hashable images, real cards, English + highres
  // first. Yields every few thousand rows: ~500k printings would otherwise
  // block the event loop for seconds.
  const reps = new Map();
  const cols = "id, lang, layout, image_status, illustration_id, frame, border_color, full_art, frame_effects, faces, image_small";
  const noncard = NONCARD_LAYOUTS.map((l) => `'${l}'`).join(",");
  const hashable = idx.prepare(
    `SELECT ${cols} FROM printings WHERE image_status IN ('highres_scan','lowres')${setSql}
     ORDER BY layout IN (${noncard}), lang <> 'en', image_status <> 'highres_scan', released_at DESC`,
  );
  let n = 0;
  for (const p of hashable.iterate(...sets)) {
    for (const u of units(p)) {
      if (!u.url) continue;
      const key = fingerprintKey(p, u.face, u.illustration_id);
      if (!reps.has(key)) reps.set(key, { key, printing_id: p.id, face: u.face, illustration_id: u.illustration_id, frame: p.frame, url: u.url });
    }
    if (++n % 5000 === 0) { if (signal?.aborted) break; await yieldNow(); }
  }

  // Groups hashed under the old key scheme from a non-card representative
  // (an art card or front card standing in for the real card): re-hash.
  idx.prepare(
    `DELETE FROM fingerprints WHERE key IN (
       SELECT f.key FROM fingerprints f JOIN printings p ON p.id = f.printing_id
        WHERE p.layout IN (${noncard}) AND f.key NOT LIKE '%|' || p.layout)`,
  ).run();

  // 2. Map every printing in scope (placeholders included) to its group, in
  // batches. Skipped on a resume when the printings and scope are unchanged.
  const mapStamp = JSON.stringify({ v: MAP_VERSION, refresh: getMeta(idx, "last_refresh"), sets: scoped ? sets : null });
  if (getMeta(idx, "fp_map") !== mapStamp && !signal?.aborted) {
    job.phase = "map";
    writeJob(idx, job);
    setMeta(idx, "fp_map", null);
    if (scoped) idx.prepare(`DELETE FROM printing_fp WHERE printing_id IN (SELECT id FROM printings WHERE 1${setSql})`).run(...sets);
    else idx.exec("DELETE FROM printing_fp");
    const ins = idx.prepare("INSERT OR REPLACE INTO printing_fp(printing_id, face, key) VALUES (?, ?, ?)");
    let inTx = false;
    let m = 0;
    try {
      for (const p of idx.prepare(`SELECT ${cols} FROM printings WHERE 1${setSql}`).iterate(...sets)) {
        if (!inTx) { idx.exec("BEGIN"); inTx = true; }
        const us = units(p);
        // Placeholder printings may lack a per-face image; map by face index anyway.
        const faces = us.length ? us : [{ face: 0, illustration_id: p.illustration_id }];
        for (const u of faces) {
          const key = fingerprintKey(p, u.face, u.illustration_id);
          if (reps.has(key)) ins.run(p.id, u.face, key);
        }
        if (++m % 2000 === 0) {
          idx.exec("COMMIT");
          inTx = false;
          if (signal?.aborted) break;
          await yieldNow();
        }
      }
      if (inTx) { idx.exec("COMMIT"); inTx = false; }
    } catch (e) {
      if (inTx) idx.exec("ROLLBACK");
      throw e;
    }
    if (!signal?.aborted) setMeta(idx, "fp_map", mapStamp);
    bumpGeneration(idx);
  }

  // 3. Hash what is missing.
  const have = new Set(idx.prepare("SELECT key FROM fingerprints").all().map((r) => r.key));
  const todo = [...reps.values()].filter((r) => !have.has(r.key));
  job.phase = "hash";
  job.total = reps.size;
  job.done = reps.size - todo.length;
  writeJob(idx, job);
  onProgress?.(job);

  const insFp = idx.prepare(
    "INSERT OR REPLACE INTO fingerprints(key, illustration_id, face, frame, printing_id, hash) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let next = 0;
  let consecutiveErrors = 0;
  let lastWrite = Date.now();
  let sinceBump = 0;
  const imagePath = (r) => path.join(imageDir, r.printing_id.slice(0, 2), `${r.printing_id}-${r.face}.jpg`);

  let stopped = false; // set when one worker gives up, so the others stop too
  async function worker() {
    while (next < todo.length) {
      if (signal?.aborted || stopped) return;
      const r = todo[next++];
      try {
        let buf = null;
        if (keepImages) buf = await readFile(imagePath(r)).catch(() => null);
        if (!buf) {
          buf = await fetchImg(r.url);
          job.fetched++;
          if (keepImages) {
            await mkdir(path.dirname(imagePath(r)), { recursive: true });
            await writeFile(imagePath(r), buf);
          }
        }
        const px = await decode(buf);
        insFp.run(r.key, r.illustration_id, r.face, r.frame, r.printing_id, hashCard(px));
        job.done++;
        sinceBump++;
        consecutiveErrors = 0;
      } catch (e) {
        if (signal?.aborted) return;
        job.errors++;
        job.last_error = String(e.message || e).slice(0, 200);
        if (++consecutiveErrors >= maxConsecutiveErrors) {
          stopped = true;
          throw new Error(`fingerprint job stopped after repeated errors: ${job.last_error}`);
        }
      }
      if (Date.now() - lastWrite > 2000) {
        lastWrite = Date.now();
        writeJob(idx, job);
        onProgress?.(job);
        if (sinceBump >= 500) { bumpGeneration(idx); sinceBump = 0; }
      }
      await yieldNow();
    }
  }

  // allSettled: the job is only over when every worker has returned.
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    const e = failed.reason;
    job.state = "error";
    job.last_error = String(e.message || e).slice(0, 200);
    writeJob(idx, job);
    bumpGeneration(idx);
    onProgress?.(job);
    throw e;
  }
  if (signal?.aborted) {
    job.state = "paused";
  } else {
    if (!scoped) idx.exec("DELETE FROM fingerprints WHERE key NOT IN (SELECT key FROM printing_fp)");
    job.state = "done";
    job.finished_at = new Date().toISOString();
  }
  job.phase = null;
  writeJob(idx, job);
  bumpGeneration(idx);
  onProgress?.(job);
  return job;
}
