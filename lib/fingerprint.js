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
// once in public/fphash.js (shared with the browser), because toolchain
// resampling differences alone cost 2–10 bits.
//
// JPEG decoding uses `djpeg` (libjpeg-turbo-progs): Scryfall images are all
// progressive JPEGs, Node can't decode JPEG, and the project takes no npm
// runtime dependencies. The reference index is built in the background from
// Scryfall "small" images (146×204, accuracy equal to "normal"), one hash per
// (illustration, frame, border, full-art, frame effects) group, never from
// placeholder or missing images.

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getMeta, runIndexWorker, setMeta } from "./cardindex.js";
// lib → public: the hash is shared with the browser (Dockerfile copies public/).
import * as fph from "../public/fphash.js";
import { FP_BYTES, SCALE, WORDS, asWords, pc } from "../public/fphash.js";

export { FP_BYTES };
const USER_AGENT = process.env.SCRYFALL_USER_AGENT || "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)";

// --- decoding --------------------------------------------------------------

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

// --- 180° retry: rotation and re-encoding --------------------------------------
// A card photographed upside down is hashed again turned by 180° (scanner
// identifyOriented). Rotating the decoded pixels avoids a lossy JPEG round
// trip for the hash; only a winning rotated result is re-encoded (cjpeg), so
// the stored photo and strip are upright. `jpegtran -rotate 180` would leave
// the partial edge blocks unrotated (or, with -trim, cut them off).

/** Decoded pixels ({width, height, channels, data}) turned by 180° (a new image). */
export function rotate180(img) {
  const { width, height } = img;
  const ch = img.channels ?? 1;
  const n = width * height;
  const src = img.data;
  const data = new Uint8Array(n * ch);
  if (ch === 1) {
    for (let i = 0; i < n; i++) data[i] = src[n - 1 - i];
  } else {
    for (let i = 0, j = (n - 1) * ch; i < n; i++, j -= ch) for (let c = 0; c < ch; c++) data[i * ch + c] = src[j + c];
  }
  return { width, height, channels: ch, data };
}

/** Rows y0..y1 (fractions) of decoded pixels, full width. */
export function cropRows(img, y0, y1) {
  const ch = img.channels ?? 1;
  const Y0 = Math.max(0, Math.round(y0 * img.height)), Y1 = Math.min(img.height, Math.max(Y0 + 1, Math.round(y1 * img.height)));
  const data = new Uint8Array(img.data.subarray(Y0 * img.width * ch, Y1 * img.width * ch));
  return { width: img.width, height: Y1 - Y0, channels: ch, data };
}

/** Encode decoded pixels (gray or RGB) as a baseline JPEG with `cjpeg`. Resolves to a Buffer. */
export function encodeJpeg(img, { quality = 90, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ch = img.channels ?? 1;
    if (ch !== 1 && ch !== 3) return reject(new Error(`encodeJpeg: ${ch} channels`));
    const hdr = Buffer.from(`${ch === 3 ? "P6" : "P5"}\n${img.width} ${img.height}\n255\n`, "latin1");
    const child = spawn("cjpeg", ["-quality", String(quality)], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => { if (err.length < 500) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.on("error", () => { /* EPIPE when cjpeg fails early */ });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`cjpeg exited ${code}: ${err.trim().slice(0, 200)}`));
      resolve(Buffer.concat(out));
    });
    child.stdin.end(Buffer.concat([hdr, Buffer.from(img.data.buffer, img.data.byteOffset, img.width * img.height * ch)]));
  });
}

/**
 * The upright card and its collector strip from a card JPEG that was taken
 * upside down: decode, rotate 180°, re-encode the card (q `cardQuality`) and
 * the bottom band `band` = [y0, y1] of the rotated card (q `stripQuality`).
 * Resolves to {card, strip} JPEG Buffers; rejects without cjpeg/djpeg.
 */
export async function uprightJpegs(cardJpeg, { band = [0.85, 1], cardQuality = 90, stripQuality = 92 } = {}) {
  const rot = rotate180(await decodeJpeg(cardJpeg));
  const [card, strip] = await Promise.all([
    encodeJpeg(rot, { quality: cardQuality }),
    encodeJpeg(cropRows(rot, band[0], band[1]), { quality: stripQuality }),
  ]);
  return { card, strip };
}

// --- hashing (public/fphash.js, shared with the browser) ----------------------

/** Area-average resample (see public/fphash.js). Returns Float32 RGB. */
export const areaResample = fph.areaResample;

const toBuf = (u) => Buffer.from(u.buffer, u.byteOffset, FP_BYTES);

/** 88-byte reference fingerprint of a card image (decoded pixels, RGB or gray). */
export function hashCard(pixels) {
  return toBuf(fph.hashAt(pixels));
}

/** The query side: 27 shift/scale variants (Buffers) of a (rectified) card image. */
export function hashQuery(pixels, opts) {
  return fph.hashQuery(pixels, opts).map(toBuf);
}

/** Normalised combined distance (0 = identical, ~0.5 = unrelated). */
export const score = fph.score;

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

  /**
   * (Re)load every fingerprint from the index. Returns the count. Reads the
   * fingerprints table only: oracle_id/name are denormalized copies
   * (cardindex syncFingerprintMeta), so no join with the large printings rows.
   */
  load() {
    const t0 = performance.now();
    // Read the generation first: a write landing during the load triggers another reload.
    const generation = getMeta(this.idx, "fp_generation");
    const rows = this.idx.prepare(
      "SELECT key, hash, illustration_id, face, printing_id, oracle_id, name FROM fingerprints",
    ).all();
    const words = new Uint32Array(rows.length * WORDS);
    const meta = new Array(rows.length);
    const byKey = new Map();
    rows.forEach((r, i) => {
      words.set(asWords(r.hash), i * WORDS);
      meta[i] = { key: r.key, printing_id: r.printing_id, face: r.face, illustration_id: r.illustration_id, oracle_id: r.oracle_id ?? null, name: r.name || null };
      byKey.set(r.key, i);
    });
    this.words = words;
    this.meta = meta;
    this.byKey = byKey;
    this.generation = generation;
    this.loadMs = Math.round(performance.now() - t0);
    return rows.length;
  }

  get size() { return this.meta.length; }

  /** Reload when the fingerprint generation changed. Returns true when it reloaded. */
  ensureLoaded() {
    const gen = getMeta(this.idx, "fp_generation");
    if (this.generation === null || gen !== this.generation) { this.load(); return true; }
    return false;
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

/**
 * The Matcher in a worker thread (lib/fingerprint-worker.js, own read-only
 * connection), so loading, query hashing and matching never block the
 * server's event loop. Same calls as Matcher, but async: hashImage(jpeg),
 * match(hashes), scorePrintings(hashes, ids); nameGap is local; plus
 * indexCall(fn, args) for the scanner's card-index lookups.
 * hashImage waits (bounded by `waitMs`) for the warm-up, then fails with a
 * "warming up" error, which the scanner treats as "no fingerprint".
 * Options: waitMs (30000), requestTimeoutMs (60000), pollMs (generation
 * check, 10000), warm (page-cache warm-up after the load, true), restartMs
 * (first respawn delay after a crash, doubling up to 60 s; 2000),
 * workerData (extra, e.g. startDelayMs for tests).
 */
export class MatcherWorker {
  constructor(file, { waitMs = 30000, requestTimeoutMs = 60000, pollMs = 10000, warm = true, restartMs = 2000, workerData = {} } = {}) {
    this.file = file;
    this.opts = { waitMs, requestTimeoutMs, pollMs, warm, restartMs, workerData };
    this.warmer = null;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.waiters = new Set();
    this.runWaiters = new Set();
    this.failures = 0; // consecutive failures without reaching ready
    this.restartTimer = null;
    this.info = {
      state: "idle", phase: null, size: 0, load_ms: null, ready_ms: null, started_at: null, loaded_at: null, error: null, backfill: null, warm: null,
    };
  }

  /** Spawn the worker (no-op while one is running). Returns this. */
  start() {
    if (this.worker || this.info.state === "closed") return this;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const t0 = Date.now();
    Object.assign(this.info, { state: "loading", phase: "start", started_at: new Date(t0).toISOString(), error: null });
    const w = new Worker(new URL("./fingerprint-worker.js", import.meta.url), {
      workerData: { file: this.file, pollMs: this.opts.pollMs, ...this.opts.workerData },
    });
    this.worker = w;
    for (const fn of this.runWaiters) fn();
    this.runWaiters.clear();
    w.on("message", (m) => {
      if (m?.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
        return;
      }
      if (m?.type === "phase") this.info.phase = m.phase;
      else if (m?.type === "backfill") this.info.backfill = { updated: m.updated, ms: m.ms };
      else if (m?.type === "ready" || m?.type === "loaded") {
        Object.assign(this.info, { state: "ready", phase: null, size: m.size, load_ms: m.load_ms, loaded_at: new Date().toISOString() });
        if (m.type === "ready") {
          this.failures = 0;
          this.info.ready_ms = Date.now() - t0;
          if (this.opts.warm) this.#warmCache();
        }
        this.#wake();
      } else if (m?.type === "error") this.#fail(new Error(m.error));
      else if (m?.type === "warn") console.warn(`[scanner] matcher worker: ${m.error}`);
    });
    w.on("error", (err) => this.#fail(err));
    w.on("exit", (code) => {
      if (this.worker !== w) return; // terminated on purpose
      this.worker = null;
      this.#fail(new Error(`matcher worker exited with code ${code}`));
    });
    return this;
  }

  // Page-cache warm-up of the index file (lib/cardindex.js warmIndex, chunked
  // async reads, so terminate() stops it at once): its own short-lived
  // worker, once, so the matcher worker keeps answering meanwhile.
  #warmCache() {
    if (this.warmer || this.info.warm) return;
    this.info.warm = { state: "running" };
    const w = new Worker(new URL("./fingerprint-worker.js", import.meta.url), { workerData: { file: this.file, task: "warm" } });
    this.warmer = w;
    w.on("message", (m) => {
      if (m?.type === "warm") this.info.warm = m.error ? { state: "error", error: m.error } : { state: "done", ms: m.ms };
    });
    w.on("error", (err) => { this.info.warm = { state: "error", error: err.message }; });
    w.on("exit", () => {
      if (this.warmer === w) this.warmer = null;
      if (this.info.warm?.state === "running") this.info.warm = { state: "error", error: "exited" };
    });
  }

  #fail(err) {
    if (this.info.state === "closed") return;
    Object.assign(this.info, { state: "error", phase: null, error: err.message, failed_at: Date.now() });
    console.warn(`[scanner] matcher worker failed: ${err.message}`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    const w = this.worker;
    this.worker = null;
    w?.terminate().catch(() => {});
    this.#wake();
    // Respawn on its own (backoff 2 s → 60 s), not only when a scan asks:
    // until then the index lookups wait for it instead of running on the
    // main thread. After MAX_FAILURES in a row it stays down (available =
    // false) and the server falls back to in-process lookups.
    this.failures++;
    if (this.failures < MatcherWorker.MAX_FAILURES) {
      const delay = Math.min(60000, this.opts.restartMs * 2 ** (this.failures - 1));
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.info.state === "error") this.start(); }, delay);
      this.restartTimer.unref?.();
    }
    for (const fn of this.runWaiters) fn();
    this.runWaiters.clear();
  }

  static MAX_FAILURES = 8;

  /** False once closed, or after MAX_FAILURES consecutive failures (no respawn pending). */
  get available() {
    if (this.info.state === "closed") return false;
    return Boolean(this.worker || this.restartTimer || this.info.state === "idle" || this.failures < MatcherWorker.MAX_FAILURES);
  }

  /**
   * Resolve true once the worker is running (it takes index lookups before
   * `ready`), false after `timeoutMs` or when it gives up. Starts an idle one.
   */
  async whenRunning(timeoutMs = 10000) {
    if (this.info.state === "idle") this.start();
    if (this.worker) return true;
    if (!this.available) return false;
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); this.runWaiters.delete(done); resolve(Boolean(this.worker)); };
      timer = setTimeout(done, timeoutMs);
      this.runWaiters.add(done);
    });
  }

  #wake() {
    for (const fn of this.waiters) fn();
    this.waiters.clear();
  }

  /** {state: idle|loading|ready|error|closed, phase, size, load_ms, ready_ms, ...} for /healthz. */
  status() {
    const { failed_at, ...info } = this.info;
    return { ...info };
  }

  get state() { return this.info.state; }
  get size() { return this.info.size; }

  /**
   * Resolve true once the matcher is loaded, false after `timeoutMs` or on
   * failure. A worker that failed more than a minute ago is restarted.
   */
  async whenReady(timeoutMs = this.opts.waitMs) {
    if (this.info.state === "error" && Date.now() - (this.info.failed_at ?? 0) > 60000) this.start();
    if (this.info.state === "idle") this.start();
    if (this.info.state === "ready") return true;
    if (this.info.state !== "loading") return false;
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.info.state === "ready"); };
      timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  #call(op, payload) {
    if (!this.worker) return Promise.reject(new Error(`matcher worker is ${this.info.state}`));
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`matcher worker: ${op} timed out after ${this.opts.requestTimeoutMs} ms`);
        reject(err);
        // A worker stuck in one statement would time out every request queued behind it: treat it
        // like a crash (terminate, reject the rest, respawn with backoff), as lib/ocr.js does.
        if (this.worker === worker) this.#fail(err);
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, op, ...payload });
    });
  }

  /**
   * Decode + hash a card JPEG in the worker (27 variants, `variants: 9` for a
   * precise capture); `rotate: 180` turns the decoded pixels first (the
   * scanner's upside-down retry). Waits for the warm-up first; null when
   * there are no reference fingerprints.
   */
  async hashImage(jpeg, { rotate = 0, variants = 27 } = {}) {
    if (!(await this.whenReady())) {
      throw new Error(this.info.state === "loading" ? "scanner warming up: fingerprints not loaded yet" : `fingerprint matcher ${this.info.state}: ${this.info.error ?? ""}`.trim());
    }
    if (!this.info.size) return null;
    const out = await this.#call("hash", { jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), rotate: rotate === 180 ? 180 : 0, variants: variants === 9 ? 9 : 27 });
    return out.map((h) => Buffer.from(h.buffer, h.byteOffset, h.byteLength));
  }

  /** Matcher.match in the worker; the array carries `bestOther` again. */
  async match(queryHashes, { topK = 20 } = {}) {
    const r = await this.#call("match", { hashes: queryHashes.map((h) => new Uint8Array(h)), topK });
    if (r.reloaded) Object.assign(this.info, { size: r.size, load_ms: r.load_ms, loaded_at: new Date().toISOString() });
    Object.defineProperty(r.results, "bestOther", { value: r.bestOther, enumerable: false });
    return r.results;
  }

  /** Matcher.scorePrintings in the worker: Map id → {score, key}. */
  async scorePrintings(queryHashes, printingIds) {
    if (!printingIds?.length) return new Map();
    return new Map(await this.#call("scorePrintings", { hashes: queryHashes.map((h) => new Uint8Array(h)), ids: printingIds }));
  }

  nameGap(results) { return Matcher.prototype.nameGap.call(this, results); }

  /**
   * A card-index lookup (lib/cardindex.js `fn(idx, ...args)`: lookupCollector,
   * getPrinting, searchTitle, ...) on the worker's connection, also during the
   * warm-up. Resolves to the plain (structured-cloned) result.
   */
  indexCall(fn, args = []) {
    return this.#call("index", { fn, args });
  }

  /** True while the worker can take requests (index lookups work before `ready`). */
  get running() { return Boolean(this.worker); }

  /** Terminate the worker (graceful shutdown); pending calls reject. */
  async close() {
    this.info.state = "closed";
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const fn of this.runWaiters) fn();
    this.runWaiters.clear();
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("matcher worker closed")); }
    this.pending.clear();
    this.#wake();
    const warmer = this.warmer;
    this.warmer = null;
    await Promise.all([w?.terminate(), warmer?.terminate()]);
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

const MAX_REDIRECTS = 5;

/** GET an image from cards.scryfall.io over a shared keep-alive agent (at most MAX_REDIRECTS redirects). */
export function fetchImage(url, { concurrency = 2, timeoutMs = 30000, signal, hops = 0 } = {}) {
  if (hops > MAX_REDIRECTS) return Promise.reject(new Error(`too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: getAgent(concurrency),
      headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/*;q=0.8" },
      timeout: timeoutMs,
      signal,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchImage(new URL(res.headers.location, url).href, { concurrency, timeoutMs, signal, hops: hops + 1 }));
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
 * buildFingerprints in a worker thread (lib/index-worker.js, own connection
 * to `file`): its whole-table statements (plan scan + sort ~0.8 s, the
 * non-card cleanup join ~0.45 s warm and minutes on a cold cache, the key
 * set, the stale-key DELETE) never block the server's event loop. Options:
 * signal, onProgress, and plain-data buildFingerprints options (concurrency,
 * sets, keepImages, imageDir, maxConsecutiveErrors). Resolves with the job.
 */
export function buildFingerprintsInWorker(file, { signal, onProgress, ...options } = {}) {
  return runIndexWorker({ file, task: "fingerprints", options }, { signal, onProgress });
}

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
  const cols = "id, oracle_id, name, lang, layout, image_status, illustration_id, frame, border_color, full_art, frame_effects, faces, image_small";
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
      if (!reps.has(key)) {
        reps.set(key, { key, printing_id: p.id, face: u.face, illustration_id: u.illustration_id, frame: p.frame, url: u.url, oracle_id: p.oracle_id, name: p.name });
      }
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
    // The new map is built in a staging table and swapped in with one transaction: the live matcher
    // (its own connection, WAL) keeps reading the old, complete map until then, also if the job is aborted.
    idx.exec("DROP TABLE IF EXISTS printing_fp_new; CREATE TABLE printing_fp_new (printing_id TEXT NOT NULL, face INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, PRIMARY KEY (printing_id, face))");
    const ins = idx.prepare("INSERT OR REPLACE INTO printing_fp_new(printing_id, face, key) VALUES (?, ?, ?)");
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
      idx.exec("DROP TABLE IF EXISTS printing_fp_new");
      throw e;
    }
    if (!signal?.aborted) {
      idx.exec("BEGIN IMMEDIATE");
      try {
        if (scoped) idx.prepare(`DELETE FROM printing_fp WHERE printing_id IN (SELECT id FROM printings WHERE 1${setSql})`).run(...sets);
        else idx.exec("DELETE FROM printing_fp");
        idx.exec("INSERT OR REPLACE INTO printing_fp(printing_id, face, key) SELECT printing_id, face, key FROM printing_fp_new");
        setMeta(idx, "fp_map", mapStamp);
        idx.exec("COMMIT");
      } catch (e) {
        idx.exec("ROLLBACK");
        throw e;
      }
    }
    idx.exec("DROP TABLE IF EXISTS printing_fp_new");
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
    "INSERT OR REPLACE INTO fingerprints(key, illustration_id, face, frame, printing_id, hash, oracle_id, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
        insFp.run(r.key, r.illustration_id, r.face, r.frame, r.printing_id, hashCard(px), r.oracle_id ?? null, r.name ?? "");
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
