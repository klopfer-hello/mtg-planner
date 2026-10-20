// Local OCR for the card scanner: the collector line at the bottom of a card
// (set code, number, language, foil star) and the title line.
//
// Why native binaries: tesseract (spawned per crop, OMP_THREAD_LIMIT=1) was as
// accurate as tesseract.js and needs no CSP change or vendored WASM; djpeg
// decodes JPEG to PNM in ~20 ms, so we get raw pixels without an npm decoder.
// In the image, tesseract runs in long-lived mtg-ocr helpers (native/mtg-ocr.c,
// byte-identical TSV, ~5x faster per call); elsewhere it is spawned per call.
// Raw OCR of the tiny collector glyphs is never trusted: set codes are matched
// against the known codes with a confusion-weighted edit distance (0/O/D,
// 4/J, E/F, ...), numbers are digit-normalised, and the ★/• separator is
// classified from pixel blob heights because OCR cannot read the glyph.
//
// Printed formats handled:
//   M15..2023  "001/269 M" / "M15 • EN"   (also "681 R" / "CLB • EN", "001 R" / "SLD ★ EN")
//   MOM+       "M 0001"    / "MOM • DE"
//   1998-2014  "123/249" only (no set, no language)
//   pre-1998   nothing (format null)

import { spawn } from "node:child_process";
import fs from "node:fs";
import { checkJpegSize } from "./fingerprint.js";

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 20_000;
const OCR_MAX_CONCURRENT = Math.max(1, Number(process.env.OCR_MAX_CONCURRENT) || 2);
const MAX_STRIP_WIDTH = 2000; // larger strips are area-downscaled (upscaling measured worse, so never up)

/** Printed collector-line language code -> Scryfall lang. SP is what cards print for Spanish; ES is an OCR-friendly alias. */
export const PRINTED_LANGS = Object.freeze({
  EN: "en", SP: "es", ES: "es", FR: "fr", DE: "de", IT: "it", PT: "pt",
  JP: "ja", KR: "ko", RU: "ru", CS: "zhs", CT: "zht", PH: "ph",
});

/** Scryfall lang -> tesseract traineddata. Latin scripts add eng (names keep English words, mana-less punctuation). */
export const TESS_LANGS = Object.freeze({
  en: "eng", de: "deu+eng", fr: "fra+eng", it: "ita+eng", es: "spa+eng", pt: "por+eng",
  ja: "jpn", ko: "kor", ru: "rus", zhs: "chi_sim", zht: "chi_tra", ph: "eng",
});

/** Tesseract language spec readTitle uses for a Scryfall lang (or a spec passed through). */
export function tessLangFor(lang = "en") {
  return TESS_LANGS[lang] ?? (/^[a-z_+]{3,}$/.test(lang) ? lang : "eng");
}

const RARITIES = "CURMSLPT";
const DIGITISH = "0-9ODQISZBGL";

// ---------------------------------------------------------------------------
// Process helpers

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= OCR_MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Spawn `cmd args`, pipe `input` to stdin, resolve with stdout as a Buffer.
 * maxBytes kills the child once stdout grows past it.
 */
function run(cmd, args, input, { timeoutMs = OCR_TIMEOUT_MS, env, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(out);
    };
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const out = [];
    let outBytes = 0;
    const errOut = [];
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > maxBytes) {
        p.kill("SIGKILL");
        finish(new Error(`${cmd} output exceeded ${maxBytes} bytes`));
        return;
      }
      out.push(d);
    });
    p.stderr.on("data", (d) => errOut.length < 20 && errOut.push(d));
    p.on("error", (e) => finish(e.code === "ENOENT" ? Object.assign(new Error(`${cmd} is not installed`), { code: "ENOENT" }) : e));
    p.on("close", (code) => {
      if (code === 0) finish(null, Buffer.concat(out));
      else finish(new Error(`${cmd} exited with ${code}: ${Buffer.concat(errOut).toString("utf8").trim().slice(0, 300)}`));
    });
    p.stdin.on("error", () => {}); // EPIPE when the binary dies early; reported via close
    p.stdin.end(input);
  });
}

const toolCache = new Map();
/** Whether a binary can be spawned (cached). Used by /healthz and the binary-dependent tests. */
export async function hasBinary(cmd) {
  if (!toolCache.has(cmd)) {
    const arg = cmd === "djpeg" || cmd === "cjpeg" ? "-version" : "--version";
    toolCache.set(cmd, new Promise((resolve) => {
      const p = spawn(cmd, [arg], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", () => resolve(true));
    }));
  }
  return toolCache.get(cmd);
}

/** {tesseract, djpeg} availability for health checks. */
export async function ocrTools() {
  const [tesseract, djpeg] = await Promise.all([hasBinary("tesseract"), hasBinary("djpeg")]);
  return { tesseract, djpeg };
}

// ---------------------------------------------------------------------------
// Pixels: PNM parse/encode, JPEG decode, crop, invert, downscale

/** Parse a binary PGM (P5) or PPM (P6) with maxval 255 into gray {width, height, data}. */
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
  if (magic !== "P5" && magic !== "P6") throw new Error(`unsupported PNM type ${JSON.stringify(magic)}`);
  const width = +token(), height = +token(), maxval = +token();
  pos++; // single whitespace before raster
  if (!(width > 0 && height > 0) || maxval !== 255) throw new Error("bad PNM header");
  const ch = magic === "P6" ? 3 : 1;
  const raster = buf.subarray(pos, pos + width * height * ch);
  if (raster.length < width * height * ch) throw new Error("truncated PNM");
  if (ch === 1) return { width, height, data: new Uint8Array(raster) };
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 3) data[i] = (raster[j] * 77 + raster[j + 1] * 150 + raster[j + 2] * 29) >> 8;
  return { width, height, data };
}

/** Encode gray pixels as a binary PGM (tesseract reads it from stdin). */
export function encodePgm({ width, height, data }) {
  const hdr = Buffer.from(`P5\n${width} ${height}\n255\n`, "latin1");
  return Buffer.concat([hdr, Buffer.from(data.buffer, data.byteOffset, width * height)]);
}

/** Decode a JPEG (or pass through a PGM/PPM) to gray pixels via `djpeg -grayscale -pnm`. */
export async function decodeGray(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf[0] === 0x50 && (buf[1] === 0x35 || buf[1] === 0x36)) return parsePnm(buf);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("expected a JPEG or PGM image");
  // The declared size bounds djpeg's output (it writes the full raster even for truncated data).
  const { width, height } = checkJpegSize(buf);
  return parsePnm(await run("djpeg", ["-grayscale", "-pnm"], buf, { timeoutMs: 10_000, maxBytes: width * height + 1024 }));
}

/** Crop by fractions of width/height. */
export function cropFrac(img, x0, y0, x1, y1) {
  const X0 = Math.max(0, Math.round(x0 * img.width)), X1 = Math.min(img.width, Math.round(x1 * img.width));
  const Y0 = Math.max(0, Math.round(y0 * img.height)), Y1 = Math.min(img.height, Math.round(y1 * img.height));
  const width = Math.max(1, X1 - X0), height = Math.max(1, Y1 - Y0);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(img.data.subarray((y + Y0) * img.width + X0, (y + Y0) * img.width + X0 + width), y * width);
  return { width, height, data };
}

/** Gray pixels turned by 180° (a new image). */
export function rotateGray180(img) {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = img.data[n - 1 - i];
  return { width: img.width, height: img.height, data };
}

/**
 * OCR inputs for the scanner's upside-down retry, from one gray decode of the
 * card: the card turned by 180° (title OCR) and the bottom band `band` =
 * [y0, y1] of the turned card as the collector strip (the card's own top
 * band; the client's strip shows the wrong end). Both are PGM Buffers, which
 * readTitle / readCollectorLine take like a JPEG.
 */
export async function rotatedOcrInputs(cardJpeg, { band = [0.85, 1] } = {}) {
  const rot = rotateGray180(await decodeGray(cardJpeg));
  return { card: encodePgm(rot), strip: encodePgm(cropFrac(rot, 0, band[0], 1, band[1])) };
}

export function invert(img) {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - img.data[i];
  return { width: img.width, height: img.height, data };
}

function median(img) {
  const hist = new Uint32Array(256);
  for (const v of img.data) hist[v]++;
  let acc = 0;
  for (let i = 0; i < 256; i++) if ((acc += hist[i]) * 2 >= img.data.length) return i;
  return 255;
}

/** Integer-factor area-average downscale until width <= maxWidth. */
function shrink(img, maxWidth) {
  const f = Math.ceil(img.width / maxWidth);
  if (f <= 1) return img;
  const width = Math.floor(img.width / f), height = Math.floor(img.height / f);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += img.data[(y * f + dy) * img.width + x * f + dx];
    data[y * width + x] = Math.round(s / (f * f));
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Tesseract

/** Parse tesseract TSV into words (level 5) and lines with bounding boxes. */
export function parseTsv(tsv) {
  const words = [];
  for (const row of tsv.split("\n").slice(1)) {
    const f = row.split("\t");
    if (f.length < 12 || f[0] !== "5" || !f[11].trim()) continue;
    const [left, top, width, height] = f.slice(6, 10).map(Number);
    words.push({ text: f[11].trim(), conf: +f[10], left, top, width, height, block: +f[2], par: +f[3], line: +f[4] });
  }
  const byLine = new Map();
  for (const w of words) {
    const key = `${w.block}.${w.par}.${w.line}`;
    const L = byLine.get(key) ?? { words: [], left: Infinity, top: Infinity, right: 0, bottom: 0 };
    L.words.push(w);
    L.left = Math.min(L.left, w.left); L.top = Math.min(L.top, w.top);
    L.right = Math.max(L.right, w.left + w.width); L.bottom = Math.max(L.bottom, w.top + w.height);
    byLine.set(key, L);
  }
  const lines = [...byLine.values()].map((L) => ({
    ...L, width: L.right - L.left, height: L.bottom - L.top, text: L.words.map((w) => w.text).join(" "),
  }));
  return { words, lines, text: lines.map((l) => l.text).join("\n") };
}

// Persistent helper (native/mtg-ocr.c, built into the image). Start-up and
// model loading were 66-95% of every spawned tesseract call (83 ms eng, 151 ms
// deu+eng on a blank image), so up to OCR_MAX_CONCURRENT long-lived helpers
// keep their TessBaseAPIs loaded. The helper replays the CLI's exact steps, so
// its TSV is byte-identical; without it (Windows, CI runner, OCR_HELPER=off)
// every call spawns tesseract as before. A helper that crashes or times out is
// killed and replaced by a fresh one on the next call; a crash retries that
// request once via the spawn path. All I/O is async (never blocks the loop).

const OCR_HELPER = process.env.OCR_HELPER ?? "/usr/local/bin/mtg-ocr";
const HELPER_MAX_OUT = 64 * 1024 * 1024;
const HELPER_MAX_FAILS = 5; // crashes in a row before the helper is benched
const HELPER_BENCH_MS = 60_000;
const MAGIC = Buffer.from("MOCR", "latin1");

const helpers = []; // {proc, busy, langs: string[] (most recent last), dead}
const helperStats = { spawned: 0, crashes: 0, timeouts: 0, fallbacks: 0, failsInRow: 0, benchedUntil: 0, lastError: null };
let helperExists = null;

function helperUsable() {
  if (!OCR_HELPER || OCR_HELPER === "off") return false;
  if (helperExists === null) {
    try { fs.accessSync(OCR_HELPER, fs.constants.X_OK); helperExists = true; } catch { helperExists = false; }
  }
  return helperExists && Date.now() >= helperStats.benchedUntil;
}

function spawnHelper() {
  const proc = spawn(OCR_HELPER, [], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
  const h = { proc, busy: false, langs: [], dead: false, onData: null, onDeath: null, die: null };
  helperStats.spawned++;
  const die = (err) => {
    if (h.dead) return;
    h.dead = true;
    const i = helpers.indexOf(h);
    if (i >= 0) helpers.splice(i, 1);
    h.onDeath?.(err);
  };
  h.die = die;
  proc.on("error", (e) => die(e));
  proc.on("exit", (code, sig) => die(new Error(`mtg-ocr exited (${sig ?? code})`)));
  proc.stdin.on("error", () => {}); // EPIPE after a crash; reported via exit
  proc.stdout.on("data", (d) => h.onData?.(d));
  // Idle helpers must not keep the process alive (tests, shutdown); a pending
  // request's timeout timer keeps the loop running while it waits.
  proc.unref();
  proc.stdin.unref?.();
  proc.stdout.unref?.();
  helpers.push(h);
  return h;
}

/** An idle helper, preferring one that already has `lang` loaded (callers hold an OCR slot). */
function takeHelper(lang) {
  const idle = helpers.filter((h) => !h.busy && !h.dead);
  let h = idle.find((x) => x.langs.includes(lang));
  if (!h && helpers.length < OCR_MAX_CONCURRENT) h = spawnHelper();
  h ??= idle[0] ?? spawnHelper(); // all busy can't happen under withSlot; stay safe
  h.busy = true;
  return h;
}

/**
 * Kill a helper and drop it from the pool at once: its 'exit' event comes later, and until then
 * takeHelper must not hand the dying process to the next call (EPIPE, a false crash, a CLI
 * fallback). A pending request (desync kill) is rejected via onDeath like a crash.
 */
function killHelper(h, why = "killed") {
  h.die?.(new Error(`mtg-ocr ${why}`));
  try { h.proc.kill("SIGKILL"); } catch { /* already gone */ }
}

/** One request to a helper: resolves the TSV Buffer; rejects with err.retry = true when the helper died. */
function helperRequest(buf, { lang, psm, whitelist, timeoutMs = OCR_TIMEOUT_MS }) {
  const h = takeHelper(lang);
  const langB = Buffer.from(lang, "utf8"), wlB = Buffer.from(whitelist, "utf8");
  const hdr = Buffer.alloc(20);
  MAGIC.copy(hdr, 0);
  hdr.writeUInt32LE(psm, 4);
  hdr.writeUInt32LE(langB.length, 8);
  hdr.writeUInt32LE(wlB.length, 12);
  hdr.writeUInt32LE(buf.length, 16);
  return new Promise((resolve, reject) => {
    let chunks = [], have = 0, done = false;
    const finish = (err, out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      h.onData = h.onDeath = null;
      h.busy = false;
      err ? reject(err) : resolve(out);
    };
    const timer = setTimeout(() => {
      helperStats.timeouts++;
      finish(new Error(`tesseract timed out after ${timeoutMs} ms`)); // clears onDeath: a timeout is no crash
      killHelper(h, "timed out");
    }, timeoutMs);
    h.onDeath = (e) => {
      helperStats.crashes++;
      helperStats.lastError = e.message;
      finish(Object.assign(new Error(`mtg-ocr failed: ${e.message}`), { retry: true }));
    };
    h.onData = (d) => {
      chunks.push(d);
      have += d.length;
      if (have < 12) return;
      const all = chunks.length > 1 ? Buffer.concat(chunks) : chunks[0];
      chunks = [all];
      if (!all.subarray(0, 4).equals(MAGIC)) { killHelper(h, "desync"); return; } // rejects via onDeath
      const status = all.readUInt32LE(4), len = all.readUInt32LE(8);
      if (len > HELPER_MAX_OUT) { killHelper(h, "answer too large"); return; }
      if (have < 12 + len) return;
      if (have > 12 + len) { killHelper(h, "sent an answer nobody asked for"); return; }
      const payload = all.subarray(12, 12 + len);
      if (status === 0) {
        helperStats.failsInRow = 0;
        h.langs = [...h.langs.filter((l) => l !== lang), lang].slice(-4); // the helper's LRU (MTG_OCR_MAX_LANGS 4)
        finish(null, Buffer.from(payload));
      } else {
        finish(new Error(`tesseract (mtg-ocr) failed: ${payload.toString("utf8").slice(0, 300)}`));
      }
    };
    if (h.dead) return h.onDeath(new Error("not running"));
    h.proc.stdin.write(Buffer.concat([hdr, langB, wlB, buf]));
  });
}

/** Tesseract TSV for one image: the persistent helper when installed, else a spawned CLI. */
async function tesseractTsv(buf, { lang, psm, whitelist = "", timeoutMs }) {
  if (helperUsable()) {
    try {
      return await helperRequest(buf, { lang, psm, whitelist, timeoutMs });
    } catch (e) {
      if (!e.retry) throw e;
      if (++helperStats.failsInRow >= HELPER_MAX_FAILS) {
        helperStats.benchedUntil = Date.now() + HELPER_BENCH_MS;
        helperStats.failsInRow = 0;
      }
      helperStats.fallbacks++; // the CLI answers this one; the next call starts a fresh helper
    }
  }
  const args = ["stdin", "stdout", "-l", lang, "--psm", String(psm)];
  if (whitelist) args.push("-c", `tessedit_char_whitelist=${whitelist}`);
  args.push("tsv");
  return run("tesseract", args, buf, { timeoutMs, env: { OMP_THREAD_LIMIT: "1" } });
}

/** State of the persistent OCR helper (for health output and tests). */
export function ocrHelperStatus() {
  const { failsInRow, benchedUntil, ...stats } = helperStats;
  const active = helperUsable();
  return { path: OCR_HELPER || null, installed: Boolean(helperExists), active, running: helpers.length, benched: Date.now() < benchedUntil, ...stats };
}

/** Stop all helpers (shutdown, tests). The next OCR call starts new ones. */
export function closeOcrHelpers() {
  for (const h of [...helpers]) killHelper(h);
}

/**
 * OCR an image (PGM/PNG/JPEG bytes) with tesseract.
 * @param {{lang?: string, psm?: number, whitelist?: string, timeoutMs?: number}} opts
 *   whitelist = tessedit_char_whitelist (empty: no restriction)
 * @returns {Promise<{words, lines, text, ms}>} words carry conf (0-100) and boxes
 */
export async function ocrImage(buf, { lang = "eng", psm = 6, whitelist = "", timeoutMs } = {}) {
  const t0 = performance.now();
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!/^[A-Za-z0-9_+-]{1,256}$/.test(lang)) throw new Error(`invalid tesseract language ${JSON.stringify(lang)}`);
  if (!(Number.isInteger(psm) && psm >= 0 && psm <= 13)) throw new Error(`invalid psm ${psm}`);
  if (Buffer.byteLength(whitelist) > 4096 || whitelist.includes("\0")) throw new Error("invalid whitelist");
  const out = await withSlot(() => tesseractTsv(buf, { lang, psm, whitelist, timeoutMs }));
  return { ...parseTsv(out.toString("utf8")), ms: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------------------
// Collector line parsing (pure; unit-tested without tesseract)

// OCR confusion pairs seen on collector crops; substituting one costs 0.5.
const CONFUSIONS = ["0O", "0D", "OD", "OC", "OQ", "1I", "1L", "IL", "2Z", "5S", "8B", "6G", "4J", "2J", "4A",
  "DF", "EF", "PF", "MN", "UV", "CE", "PD", "KX", "7T", "TI", "HN", "RP", "RB", "WV", "UJ"];
const CONF = new Set(CONFUSIONS.flatMap((p) => [p, p[1] + p[0]]));

/** Confusion-weighted Levenshtein distance (uppercase inputs). */
export function wlev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const s = a[i - 1] === b[j - 1] ? 0 : CONF.has(a[i - 1] + b[j - 1]) ? 0.5 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + s);
  }
  return d[a.length][b.length];
}

/** Map OCR look-alikes to digits ("O72" -> "072", "B3" -> "83"). */
export const digitize = (s) =>
  s.replace(/[ODQ]/g, "0").replace(/[IL|!]/g, "1").replace(/Z/g, "2").replace(/[S$]/g, "5").replace(/B/g, "8").replace(/G/g, "6");
// Second reading for the ambiguous S and B (both also stand in for a blurred 3).
const digitizeAlt = (s) => digitize(s.replace(/[SB]/g, "3"));

const codeCache = new WeakMap();
function knownCodes(setCodes) {
  const list = typeof setCodes === "function" ? setCodes() : setCodes;
  if (!list) return [];
  if (codeCache.has(list)) return codeCache.get(list);
  const codes = [...new Set([...list].map((c) => String(c).toUpperCase()).filter((c) => c.length >= 2 && c.length <= 5))];
  codeCache.set(list, codes);
  return codes;
}

/** Rank known set codes against an OCR'd code. score = 1 - cost/2 (exact 1, one confusion 0.75, one edit 0.5). */
export function matchSetCode(ocr, setCodes, { maxCost = 1, limit = 8 } = {}) {
  const want = ocr.toUpperCase();
  return knownCodes(setCodes)
    .map((code) => ({ code: code.toLowerCase(), cost: wlev(want, code) }))
    .filter((x) => x.cost <= maxCost)
    .sort((a, b) => a.cost - b.cost || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map(({ code, cost }) => ({ code, cost, score: +(1 - cost / 2).toFixed(3) }));
}

function matchLang(s) {
  let best = null;
  for (const code of Object.keys(PRINTED_LANGS)) {
    const cost = wlev(s, code);
    if (!best || cost < best.cost) best = { code, cost };
  }
  return best;
}

// A set code token: 3-4 alphanumerics; 4-char tokens need a letter (else it is a year or a number).
const isSetTok = (t) => /^[A-Z0-9]{3,4}$/.test(t) && (t.length === 3 || /[A-Z]/.test(t));

/**
 * Split one OCR line into (set, lang) readings by token shape, so prose like
 * "Christopher Moeller" or "1993-2009 Wizards" never looks like a set line.
 * Shapes: "SET LANG", "SET x LANG" (separator read as a letter), "SET xLANG", "SETLANG" (glued).
 */
function setLangReadings(line) {
  // codes are printed in capitals: a token with 2+ lowercase letters is prose (artist, flavour text)
  const toks = line.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map((t) => ((t.match(/[a-z]/g) ?? []).length >= 2 ? "~" : t.toUpperCase()));
  const out = [];
  for (const skip of [0, 1]) { // skip=1 tolerates one short junk token (The List icon, border noise)
    if (skip && !(toks[0]?.length <= 2)) continue;
    const [a, b, c] = toks.slice(skip);
    const pen = skip * 0.3;
    if (!a) continue;
    if (isSetTok(a) && b?.length === 2) out.push({ set: a, lang: b, pen });
    if (isSetTok(a) && b?.length === 3) out.push({ set: a, lang: b.slice(1), pen: pen + 0.3 });
    if (isSetTok(a) && b?.length === 1 && c?.length === 2) out.push({ set: a, lang: c, pen: pen + 0.3 });
    // glued "NCCEN" / "NCCXEN" only on all-capital lines: allowed next to an artist name, "OSRRER" and
    // "DSKSER" became false m15 lines (FR) that beat the right read on the 25 beta.1 prod strips
    if (a.length >= 5 && a.length <= 7 && /[A-Z]{2}$/.test(a) && !/[a-z]/.test(line))
      for (const setLen of [3, 4]) {
        const set = a.slice(0, setLen), rest = a.slice(setLen);
        if (isSetTok(set) && (rest.length === 2 || rest.length === 3)) out.push({ set, lang: rest.slice(-2), pen: pen + 0.2 + (rest.length - 2) * 0.2 });
      }
  }
  return out;
}

/** Find the "SET • LANG" line: returns {index, setCands, langCode, langCost, setText, score} or null. */
function findSetLine(lines, setCodes) {
  let best = null;
  lines.forEach((L, index) => {
    for (const { set, lang, pen } of setLangReadings(L)) {
      const lm = matchLang(lang);
      if (lm.cost > 1) continue;
      const setCands = matchSetCode(set, setCodes);
      if (!setCands.length) continue;
      const score = lm.cost + setCands[0].cost + (set.length === 4 ? 0.3 : 0) + pen;
      if (score > 2) continue;
      if (!best || score < best.score) best = { index, setCands, langCode: lm.code, langCost: lm.cost, setText: set, score };
    }
  });
  return best;
}

/** Fallback when the language code is unreadable: a lone set token right below a strong number line. */
function findSetOnlyLine(lines, setCodes) {
  for (let index = 1; index < lines.length; index++) {
    const tok = lines[index].replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ")[0] ?? "";
    if (!isSetTok(tok)) continue; // uppercase only
    const num = parseNumberLine(lines[index - 1]);
    if (!num.nums.length || num.nums[0].strength < 1) continue;
    const setCands = matchSetCode(tok, setCodes, { maxCost: 0.5 });
    if (setCands.length) return { index, setCands, langCode: null, langCost: 2, setText: tok, score: 2 + setCands[0].cost };
  }
  return null;
}

const D = `[${DIGITISH}]`;
/** Parse the number line of the modern block. */
function parseNumberLine(L) {
  const s = L.toUpperCase();
  const nums = [];
  const add = (n, strength) => {
    if (/^\d{1,4}$/.test(n) && +n > 0 && !nums.some((x) => x.n === String(+n))) nums.push({ n: String(+n), raw: n, strength });
  };
  const push = (raw, strength) => {
    strength *= 0.75 ** (raw.match(/[SBGZILQD|!$]/g) ?? []).length; // letters standing in for digits (O is routine)
    add(digitize(raw), strength);
    if (/[SB]/.test(raw)) alt.push([digitizeAlt(raw), strength * 0.7]); // "O8S" may be 083
  };
  const alt = [];
  let rarity = null, total = null, format = null;
  // MOM+: "M 0317" (rarity first, 4 digits, no total)
  let m = s.match(new RegExp(`(?:^|[^A-Z0-9])([${RARITIES}])\\s*(${D}{4})(?![0-9A-Z/]|\\s*[-–.])`));
  if (m && (m[2].match(/\d/g) ?? []).length >= 2) { rarity = m[1]; push(m[2], 1); format = "mom"; }
  // M15: "001/269 M"
  m = s.match(new RegExp(`(${D}{1,4})\\s*/\\s*(${D}{2,4})(?:\\s*([${RARITIES}])(?![A-Z]))?`));
  if (m) {
    push(m[1], 1);
    const t = digitize(m[2]);
    if (/^\d+$/.test(t)) total = String(+t);
    rarity ??= m[3] ?? null;
    format ??= "m15";
  }
  // M15 without total: "681 R", "001 R" (Secret Lair, Commander)
  m = s.match(new RegExp(`(?:^|\\s)(${D}{1,4})\\s+([${RARITIES}])(?![A-Z0-9])`));
  if (m && (m[1].match(/\d/g) ?? []).length >= 1) { push(m[1], 0.9); rarity ??= m[2]; format ??= "m15"; }
  // weaker: tokens with >= 2 real digits, then anything numeric-ish; a power/toughness box ("6/6", "1/1",
  // "*/2") is never a collector number (it sits right above the line on many frames)
  const w = s.replace(/(^|[^0-9A-Z])[0-9X*]{1,2}\s*\/\s*[0-9X*]{1,2}(?![0-9A-Z])/g, "$1 ");
  for (const t of w.matchAll(new RegExp(`\\b(${D}{1,4})\\b`, "g"))) if ((t[1].match(/\d/g) ?? []).length >= 2) push(t[1], 0.6);
  for (const t of w.matchAll(new RegExp(`\\b(${D}{1,4})\\b`, "g"))) if (/\d/.test(t[1])) push(t[1], 0.4);
  for (const [n, st] of alt) add(n, st);
  // a stray glyph glued to a 3-4 digit number: also try dropping one end
  for (const x of [...nums]) if (x.n.length >= 3) { add(x.n.slice(0, -1), x.strength * 0.5); add(x.n.slice(1), x.strength * 0.5); }
  nums.sort((a, b) => b.strength - a.strength);
  return { nums, rarity, total, format };
}

/**
 * Find 1998-2014 style "nnn/ttt" readings anywhere in the text, best first.
 * The tiny slash is often read as "1", "7", "I" or dropped ("1461249", "150306"),
 * so on the copyright line a trailing digit run is also split into number/total.
 */
export function parseLegacy(upper) {
  const found = [];
  const add = (n, t, strength, padded = false) => {
    if (!/^\d{1,3}$/.test(n) || !/^[1-9]\d{1,2}$/.test(t) || +n === 0 || +t < 10 || +t > 450) return; // legacy sets: 10..~400 cards
    const plausible = +n <= +t * 1.2 ? 1 : 0.4; // numbers rarely exceed the printed total (a few extras do)
    const st = +(strength * plausible * (t.length === 3 ? 1 : 0.8)).toFixed(3);
    const prev = found.find((x) => x.number === String(+n) && x.total === String(+t));
    if (prev) prev.strength = Math.max(prev.strength, st);
    else found.push({ number: String(+n), total: String(+t), strength: st, padded });
  };
  for (const L of upper) {
    // the number follows the copyright notice ("... Wizards of the Coast, Inc. 50/350")
    const legal = /WIZARD|COAST|INC\b|LLC|19\d\d|20\d\d|[©™]/.test(L);
    for (const m of L.matchAll(new RegExp(`(?:^|[^0-9A-Z])(${D}{1,3})\\s*/\\s*(${D}{1,3})(?![0-9])`, "g"))) {
      const n = digitize(m[1]), t = digitize(m[2]);
      if (!legal && +t < 20) continue; // power/toughness like "3/6" or "10/10"
      const realDigits = (m[1] + m[2]).replace(/\D/g, "").length / (m[1].length + m[2].length);
      add(n, t, realDigits * (legal ? 1 : 0.7), /^0\d\d$/.test(n)); // M15 zero-pads to 3 digits; legacy never did
    }
    if (!legal) continue;
    // digit runs after the copyright years, e.g. "LLC 1461249" or "INC. 150306"
    const tail = L.replace(/[©@]?\s*(?<!\d)[12][09]\d\d(?!\d)(\s*[-–:."”']?\s*[12][09]\d\d(?!\d))?/g, " "); // copyright years
    for (const m of tail.matchAll(new RegExp(`(?:^|[^0-9A-Z])([0-9ODQISZBG]{5,7})(?![0-9A-Z])`, "g"))) {
      const run = digitize(m[1]);
      if (!/^\d+$/.test(run) || (m[1].match(/\d/g) ?? []).length < m[1].length - 1) continue;
      for (let i = 1; i <= 3; i++) {
        const n = run.slice(0, i), rest = run.slice(i);
        if (rest.length === 3) add(n, rest, 0.6); // slash dropped
        if (rest.length === 4 && /^[17]/.test(rest)) add(n, rest.slice(1), 0.7); // slash read as 1 / 7
      }
    }
  }
  found.sort((a, b) => b.strength - a.strength);
  // blurred totals swap look-alike digits (350 read as 360): offer those as weaker readings
  const SWAP = { 5: "6", 6: "5", 3: "8", 8: "3", 0: "8", 1: "7", 7: "1" };
  for (const x of found.slice(0, 2)) {
    [...x.total].forEach((ch, i) => {
      if (SWAP[ch] && i > 0) add(x.number, x.total.slice(0, i) + SWAP[ch] + x.total.slice(i + 1), x.strength * 0.5);
    });
  }
  return found.sort((a, b) => b.strength - a.strength);
}

/**
 * Parse collector-line OCR text into structured fields (no pixels: separator not decided here).
 * @param {string|{text:string, words?:object[]}[]} input OCR text, or tesseract lines
 * @param {{setCodes: string[]|(() => string[])}} opts known set codes (any case)
 */
export function parseCollectorText(input, { setCodes } = {}) {
  const lines = typeof input === "string"
    ? input.split("\n").map((text) => ({ text, words: [] }))
    : input;
  const kept = lines.filter((l) => l.text.trim());
  const upper = kept.map((l) => l.text.trim().toUpperCase());
  const out = {
    raw: kept.map((l) => l.text.trim()).join("\n"), format: null, rarity: null, number: null, numberCandidates: [], total: null,
    legacyCandidates: [], setCandidates: [], setText: null, langCode: null, lang: null, langCost: null, separator: null, separatorConfidence: 0,
    confidence: 0, setLine: null, numberLine: null,
  };
  const meanConf = (ls) => {
    const ws = ls.flatMap((l) => l?.words ?? []).filter((w) => w.conf >= 0);
    return ws.length ? ws.reduce((a, w) => a + w.conf, 0) / ws.length / 100 : 0.5;
  };

  const orig = kept.map((l) => l.text.trim());
  const sl = findSetLine(orig, setCodes) ?? findSetOnlyLine(orig, setCodes);
  if (sl) {
    // the number line is normally right above; fall back to neighbours
    let num = null, numIdx = -1;
    for (const j of [sl.index - 1, sl.index - 2, sl.index + 1]) {
      if (j < 0 || j >= upper.length) continue;
      const p = parseNumberLine(upper[j]);
      if (p.nums.length && (!num || p.nums[0].strength > num.nums[0].strength)) { num = p; numIdx = j; }
    }
    out.setCandidates = sl.setCands.map(({ code, score, cost }) => ({ code, score, cost }));
    out.setText = sl.setText;
    out.langCode = sl.langCode === "ES" ? "SP" : sl.langCode;
    out.lang = PRINTED_LANGS[sl.langCode] ?? null;
    out.langCost = sl.langCost;
    out.setLine = sl.index;
    if (num) {
      out.numberLine = numIdx;
      out.numberCandidates = num.nums.slice(0, 5).map((x) => x.n);
      out.number = out.numberCandidates[0];
      out.total = num.total;
      out.rarity = num.rarity;
      out.format = num.format ?? (num.nums[0].raw.length === 4 ? "mom" : "m15");
    } else {
      out.format = "m15";
    }
    const s = out.setCandidates[0].score;
    const tie = out.setCandidates.filter((c) => c.score === s).length > 1 ? 0.85 : 1;
    const l = sl.langCode ? 1 - sl.langCost / 2 : 0.4;
    const n = num ? num.nums[0].strength : 0.2;
    const wc = meanConf([kept[sl.index], numIdx >= 0 ? kept[numIdx] : null]);
    out.confidence = +(s * tie * l * n * (0.7 + 0.3 * wc)).toFixed(3);
    return out;
  }

  const legacy = parseLegacy(upper);
  if (legacy.length) {
    const lg = legacy[0];
    out.format = lg.padded ? "m15" : "legacy";
    out.number = lg.number;
    out.total = lg.total;
    out.numberCandidates = [...new Set(legacy.map((x) => x.number))].slice(0, 5);
    out.legacyCandidates = legacy.slice(0, 5).map(({ number, total, strength }) => ({ number, total, score: strength }));
    const tie = legacy.length > 1 && legacy[1].strength >= lg.strength * 0.9 ? 0.8 : 1;
    const noSet = lg.padded ? 0.6 : 1; // an M15-style number whose set line was unreadable
    out.confidence = +(0.9 * lg.strength * tie * noSet * (0.7 + 0.3 * meanConf(kept))).toFixed(3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ★ / • separator classifier (pixels)

function otsu(vals) {
  const hist = new Array(256).fill(0);
  for (const v of vals) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = vals.length - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  return th;
}

/** 8-connected components of the pixels on the glyph side of `th` inside [X0,X1)x[Y0,Y1). */
function components(img, X0, Y0, X1, Y1, th, light) {
  const W = X1 - X0, H = Y1 - Y0, seen = new Uint8Array(W * H);
  const on = (x, y) => { const v = img.data[(y + Y0) * img.width + x + X0]; return light ? v > th : v <= th; };
  const out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (seen[y * W + x] || !on(x, y)) continue;
    const c = { x0: x, x1: x, y0: y, y1: y, n: 0 }, st = [y * W + x];
    seen[y * W + x] = 1;
    while (st.length) {
      const p = st.pop(), py = (p / W) | 0, px = p % W;
      c.n++;
      if (px < c.x0) c.x0 = px; if (px > c.x1) c.x1 = px; if (py < c.y0) c.y0 = py; if (py > c.y1) c.y1 = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx] || !on(nx, ny)) continue;
        seen[ny * W + nx] = 1;
        st.push(ny * W + nx);
      }
    }
    out.push(c);
  }
  return out;
}

const medianOf = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; };
const alnum = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Classify the separator between set code and language code (CR 213.1e: ★ = premium/foil, • = not).
 * Works on glyph COLUMNS, not on tesseract's character guesses (beta.1 lost ★s that tesseract glued
 * into the language word, "*EN"/"WEN", and measured letters against 36 px word boxes of 22 px text):
 * - polarity is decided around the set word itself (a white box floor in the strip padding made the
 *   whole-crop median light and inverted a dark line into one blob);
 * - only blobs centred on that text line count; blobs overlapping in x merge into one column;
 * - the column right after the set code's letters is the separator; cap height = median of the
 *   set-code and the two language-letter columns; height / cap >= starMin means ★ (prod ★ 0.69-0.94).
 * Confidence needs that structure: set letters, separator, two letter-sized language columns.
 * @param img gray pixels, either polarity (the crop as decoded)
 * @param line tesseract line {words[{text,left,top,width,height}]} in img coordinates
 * @param {{starMin?: number, setText?: string}} opts setText: the set code as OCR read it
 * @returns {{separator:'star'|'dot'|null, rel?, fill?, cap?, confidence, why?}}
 */
export function classifySeparator(img, line, { starMin = 0.62, setText = null } = {}) {
  const ws = (line?.words ?? []).filter((w) => alnum(w.text));
  if (!ws.length) return { separator: null, confidence: 0, why: "no words" };
  const set = alnum(setText);
  const setW = (set.length >= 3 && ws.find((w) => alnum(w.text).startsWith(set)))
    || ws.find((w, i) => alnum(w.text).length >= 3 && !(i === 0 && ws.length >= 3 && alnum(w.text).length <= 1));
  if (!setW) return { separator: null, confidence: 0, why: "no set" };
  const setLen = set.length >= 3 && set.length <= 4 ? set.length : 3;
  const h = setW.height;
  // the set word plus room for "★ EN" after it (also when tesseract cut the word short)
  const X0 = Math.max(0, Math.round(setW.left - 0.3 * h));
  const X1 = Math.min(img.width, Math.round(setW.left + setW.width * (1 + (2.2 * 3) / setLen) + h));
  const Y0 = Math.max(0, Math.round(setW.top - 0.4 * h)), Y1 = Math.min(img.height, Math.round(setW.top + 1.4 * h));
  if (X1 - X0 < 4 || Y1 - Y0 < 4) return { separator: null, confidence: 0, why: "empty region" };
  const vals = [];
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) vals.push(img.data[y * img.width + x]);
  const light = medianOf(vals) < 128; // glyphs lighter than the local background
  const th = otsu(vals);
  const bandTop = setW.top - Y0, bandBot = setW.top + h - Y0, leftX = setW.left - X0 - 0.2 * h;
  const cs = components(img, X0, Y0, X1, Y1, th, light)
    .filter((c) => c.n >= 4 && c.y1 - c.y0 + 1 <= 2.2 * h) // specks; background-sized blobs
    .filter((c) => { const cy = (c.y0 + c.y1) / 2; return cy >= bandTop - 0.15 * h && cy <= bandBot + 0.15 * h; })
    .filter((c) => (c.x0 + c.x1) / 2 >= leftX)
    .sort((a, b) => a.x0 - b.x0);
  const cols = [];
  for (const c of cs) {
    const last = cols[cols.length - 1];
    if (last && c.x0 <= last.x1 - 1) {
      last.x1 = Math.max(last.x1, c.x1); last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1); last.n += c.n;
    } else cols.push({ ...c });
  }
  if (!cols.length) return { separator: null, confidence: 0, why: "no columns", light };
  const hs = cols.map((c) => c.y1 - c.y0 + 1);
  const tall = Math.max(...hs);
  const capGuess = medianOf(hs.filter((v) => v >= 0.5 * tall));
  const sig = cols.filter((c, i) => hs[i] >= 0.25 * capGuess && c.n >= 0.04 * capGuess * capGuess);
  if (sig.length < setLen + 3) return { separator: null, confidence: 0, why: `columns ${sig.length}`, light };
  const H = sig.map((c) => c.y1 - c.y0 + 1);
  const letterH = [...H.slice(0, setLen), H[setLen + 1], H[setLen + 2]];
  const cap = medianOf(letterH);
  const s = sig[setLen], sh = H[setLen], sw = s.x1 - s.x0 + 1;
  const rel = sh / cap, fill = s.n / (sw * sh);
  if (rel > 0.95) return { separator: null, rel: +rel.toFixed(3), cap, confidence: 0, why: "letter-sized blob", light };
  // structure: every letter column letter-sized, the separator no wider than a letter
  const structured = letterH.every((v) => v >= 0.75 * cap && v <= 1.3 * cap) && sw <= 1.3 * cap;
  return {
    separator: rel >= starMin ? "star" : "dot",
    rel: +rel.toFixed(3), fill: +fill.toFixed(3), cap, light,
    confidence: structured ? +Math.min(1, Math.abs(rel - starMin) / 0.08).toFixed(3) : 0,
    ...(structured ? {} : { why: "structure" }),
  };
}

// ---------------------------------------------------------------------------
// Public pipeline entry points

/** One OCR pass over a region of the strip (dark-on-light for tesseract; the classifier takes either polarity). */
async function collectorPass(gray, region, opts) {
  const crop = shrink(cropFrac(gray, ...region), MAX_STRIP_WIDTH);
  const darkBg = median(crop) < 128;
  const forTess = darkBg ? invert(crop) : crop;
  const ocr = await ocrImage(encodePgm(forTess), { lang: "eng", psm: 6 });
  const parsed = parseCollectorText(ocr.lines, opts);
  if (parsed.setLine != null && parsed.langCode) {
    // the classifier decides polarity around the set word itself (crop, not the whole-crop guess)
    const sep = classifySeparator(crop, ocr.lines.filter((l) => l.text.trim())[parsed.setLine], { starMin: opts.starMin, setText: parsed.setText });
    parsed.separator = sep.separator;
    parsed.separatorConfidence = sep.confidence;
    parsed.separatorRel = sep.rel ?? null;
    parsed.separatorWhy = sep.why ?? null;
    parsed.separatorCap = sep.cap ?? null;
    parsed.separatorFill = sep.fill ?? null;
  }
  return { parsed, ms: ocr.ms, darkBg, size: [crop.width, crop.height] };
}

const passOk = (p) => p.format === "mom" || (p.format === "m15" && p.setCandidates.length > 0 && p.number);

/**
 * Read the collector block from the high-res bottom strip of a rectified card.
 * Pass 1 OCRs the left part (where M15+ prints the block); if that yields no
 * modern line, pass 2 OCRs the full width (legacy "nnn/ttt" sits centre/right).
 * @param {Buffer} stripJpeg JPEG (or PGM) of the bottom ~12% of the card, full card width
 * @param {{setCodes: string[]|(() => string[]), starMin?: number, region?: number[]}} opts
 * @returns {Promise<{raw, format:'mom'|'m15'|'legacy'|null, rarity, number, numberCandidates, total,
 *   setCandidates:{code, score, cost}[], langCode, lang, separator:'star'|'dot'|null, separatorConfidence,
 *   separatorRel, separatorWhy, separatorCap, separatorFill, confidence, passes, ms}>}
 */
export async function readCollectorLine(stripJpeg, opts = {}) {
  const t0 = performance.now();
  const gray = await decodeGray(stripJpeg);
  const passes = [];
  const left = opts.region ?? [0, 0, 0.56, 1];
  const p1 = await collectorPass(gray, left, opts);
  passes.push({ region: "left", ms: p1.ms, darkBg: p1.darkBg, format: p1.parsed.format, confidence: p1.parsed.confidence });
  let best = p1.parsed;
  if (!passOk(best)) {
    const p2 = await collectorPass(gray, [0, 0, 1, 1], opts);
    passes.push({ region: "full", ms: p2.ms, darkBg: p2.darkBg, format: p2.parsed.format, confidence: p2.parsed.confidence });
    const rank = (p) => (passOk(p) ? 2 : p.format ? 1 : 0) + p.confidence;
    if (rank(p2.parsed) > rank(best)) best = p2.parsed;
  }
  delete best.setLine;
  delete best.numberLine;
  return {
    ...best, separatorRel: best.separatorRel ?? null, separatorWhy: best.separatorWhy ?? null, separatorCap: best.separatorCap ?? null,
    separatorFill: best.separatorFill ?? null, passes, ms: Math.round(performance.now() - t0),
  };
}

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー・、";

/**
 * OCR the title line of a rectified card (crop x 4-84%, y 4.5-12%, retry at 2.5-9.5%).
 * @param {Buffer} cardJpeg rectified card JPEG (~1000x1400) or PGM
 * @param {{lang?: string, gray?: object|Promise<object>}} opts Scryfall lang (en, de, ja, ...) or a tesseract
 *   spec (e.g. "deu+eng"); `gray`: the card already decoded by decodeGray (one decode for several reads)
 * @returns {Promise<{text, confidence, words, tessLang, ms}>}
 */
export async function readTitle(cardJpeg, { lang = "en", gray: grayIn = null } = {}) {
  const gray = grayIn ? await grayIn : await decodeGray(cardJpeg);
  const tessLang = tessLangFor(lang);
  // Title band of a rectified card. y 4.5-12% fits 2003+ frames (85% of the
  // research captures read >= 0.75); 1993-1997 frames sit higher, so a weak
  // read retries at y 2.5-9.5% and keeps the more confident one (90% overall).
  const meanConf = (o) => {
    const ws = o.words.filter((w) => w.conf >= 0 && w.text.trim());
    return ws.length ? ws.reduce((a, w) => a + w.conf, 0) / ws.length / 100 : 0;
  };
  let ocr = await ocrImage(encodePgm(cropFrac(gray, 0.04, 0.045, 0.84, 0.12)), { lang: tessLang, psm: 7 });
  if (meanConf(ocr) < 0.75) {
    const alt = await ocrImage(encodePgm(cropFrac(gray, 0.04, 0.025, 0.84, 0.095)), { lang: tessLang, psm: 7 });
    if (meanConf(alt) > meanConf(ocr)) ocr = { ...alt, ms: alt.ms + ocr.ms };
  }
  let text = ocr.text.replace(/\s+/g, " ").trim();
  // tesseract spaces out CJK glyphs; join them back
  text = text.replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "gu"), "");
  const ws = ocr.words.filter((w) => w.conf >= 0);
  const confidence = ws.length ? +(ws.reduce((a, w) => a + w.conf, 0) / ws.length / 100).toFixed(3) : 0;
  return { text, confidence, words: ocr.words.map(({ text, conf }) => ({ text, conf })), tessLang, ms: ocr.ms };
}

// ---------------------------------------------------------------------------
// Fuzzy name similarity for title OCR vs. (printed) names

function lev(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export const normalizeName = (s) =>
  String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Similarity 0..1 of a card name against the best-matching window of title OCR text
 * (the mana cost and frame noise sit around the name, so substrings are compared).
 */
export function nameSimilarity(ocr, name) {
  const o = normalizeName(ocr), n = normalizeName(name);
  if (!o || !n) return 0;
  let best = lev(o, n);
  if (new RegExp(`[${CJK}]`, "u").test(n)) {
    const g = [...o.replace(/ /g, "")], nn = n.replace(/ /g, "");
    const L = [...nn].length;
    for (let i = 0; i < g.length; i++) for (let k = i + 1; k <= Math.min(g.length, i + L + 3); k++) best = Math.min(best, lev(g.slice(i, k).join(""), nn));
    return Math.max(0, 1 - best / L);
  }
  const w = o.split(" ");
  for (let i = 0; i < w.length; i++) for (let k = i + 1; k <= w.length; k++) best = Math.min(best, lev(w.slice(i, k).join(" "), n));
  return Math.max(0, 1 - best / n.length);
}
