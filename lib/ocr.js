// Local OCR for the card scanner: the collector line at the bottom of a card
// (set code, number, language, foil star) and the title line.
//
// Why native binaries: tesseract (spawned per crop, OMP_THREAD_LIMIT=1) was as
// accurate as tesseract.js and needs no CSP change or vendored WASM; djpeg
// decodes JPEG to PNM in ~20 ms, so we get raw pixels without an npm decoder.
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
/** Whether a binary can be spawned (cached). Used by /healthz. */
export async function hasBinary(cmd) {
  if (!toolCache.has(cmd)) {
    const arg = cmd === "djpeg" ? "-version" : "--version";
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

/**
 * OCR an image (PGM/PNG/JPEG bytes) with tesseract from stdin.
 * @returns {Promise<{words, lines, text, ms}>} words carry conf (0-100) and boxes
 */
export async function ocrImage(buf, { lang = "eng", psm = 6, timeoutMs } = {}) {
  const t0 = performance.now();
  const out = await withSlot(() =>
    run("tesseract", ["stdin", "stdout", "-l", lang, "--psm", String(psm), "tsv"], buf, {
      timeoutMs, env: { OMP_THREAD_LIMIT: "1" },
    }));
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
    if (a.length >= 5 && a.length <= 7 && /[A-Z]{2}$/.test(a) && !/[a-z]/.test(line)) // glued "NCCEN" / "NCCXEN"
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
  // weaker: tokens with >= 2 real digits, then anything numeric-ish
  for (const t of s.matchAll(new RegExp(`\\b(${D}{1,4})\\b`, "g"))) if ((t[1].match(/\d/g) ?? []).length >= 2) push(t[1], 0.6);
  for (const t of s.matchAll(new RegExp(`\\b(${D}{1,4})\\b`, "g"))) if (/\d/.test(t[1])) push(t[1], 0.4);
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

const LANG_RE = /(EN|DE|FR|IT|ES|SP|PT|JP|KR|RU|CS|CT|PH)$/;

/**
 * Classify the separator between set code and language code (CR 213.1e: ★ = premium/foil, • = not).
 * Character x-positions are estimated from tesseract word boxes; inside the gap between the 3rd
 * set-code character and the language code, the largest bright sub-letter blob decides:
 * height / cap height >= starMin means ★ (measured: dots 0.50-0.56, stars 0.67-0.86).
 * @param img gray pixels with LIGHT glyphs on a DARK background
 * @param line tesseract line {words, top, height, left, width} in img coordinates
 * @returns {{separator:'star'|'dot'|null, rel?, fill?, confidence, why?}}
 */
export function classifySeparator(img, line, { starMin = 0.62 } = {}) {
  const ws = line?.words ?? [];
  if (!ws.length) return { separator: null, confidence: 0, why: "no words" };
  const chars = [];
  ws.forEach((w, wi) => {
    const t = [...w.text];
    t.forEach((c, j) => chars.push({ c: c.toUpperCase(), x0: w.left + (w.width * j) / t.length, x1: w.left + (w.width * (j + 1)) / t.length, wi }));
    if (wi < ws.length - 1) chars.push({ c: " " });
  });
  const isAl = (c) => /[A-Z0-9]/.test(c);
  // skip a leading junk token (e.g. The List icon) when it is a lone short word
  let startAt = 0;
  if (ws.length >= 3 && ws[0].text.replace(/[^A-Za-z0-9]/g, "").length <= 1) startAt = [...ws[0].text].length + 1;
  let k = 0, setEnd = -1;
  for (let i = startAt; i < chars.length; i++) if (isAl(chars[i].c) && ++k === 3) { setEnd = i; break; }
  if (setEnd < 0) return { separator: null, confidence: 0, why: "no set" };
  let langStart = -1;
  for (let i = setEnd + 1; i < chars.length - 1; i++)
    if (/[A-Z]/.test(chars[i].c) && /[A-Z]/.test(chars[i + 1].c) && LANG_RE.test(chars[i].c + chars[i + 1].c)) { langStart = i; break; }
  if (langStart < 0) // misread code ("OF" for DE, "2P" for JP): first alphanumeric pair within one edit of a code
    for (let i = setEnd + 1; i < chars.length - 1; i++)
      if (isAl(chars[i].c) && isAl(chars[i + 1].c) && matchLang(chars[i].c + chars[i + 1].c).cost <= 1) { langStart = i; break; }
  if (langStart < 0) return { separator: null, confidence: 0, why: "no lang" }; // gap position unknown
  const cap = ws[chars[setEnd].wi].height;
  const gx0 = chars[setEnd].x1 - cap * 0.25, gx1 = chars[langStart].x0 + cap * 0.25;
  const y0 = Math.max(0, line.top - 2), y1 = Math.min(img.height, line.top + line.height + 2);
  const x0 = Math.max(0, Math.floor(gx0)), x1 = Math.min(img.width, Math.ceil(gx1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return { separator: null, confidence: 0, why: "empty gap" };
  const vals = [];
  for (let y = y0; y < y1; y++) for (let x = Math.max(0, line.left); x < Math.min(img.width, line.left + line.width); x++) vals.push(img.data[y * img.width + x]);
  const th = otsu(vals);
  const W = x1 - x0, H = y1 - y0, seen = new Uint8Array(W * H);
  const px = (x, y) => img.data[(y + y0) * img.width + x + x0];
  let best = null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (seen[y * W + x] || px(x, y) <= th) continue;
    const c = { x0: x, x1: x, y0: y, y1: y, n: 0 };
    const st = [y * W + x];
    seen[y * W + x] = 1;
    while (st.length) {
      const p = st.pop(), py = (p / W) | 0, pxx = p % W;
      c.n++;
      c.x0 = Math.min(c.x0, pxx); c.x1 = Math.max(c.x1, pxx); c.y0 = Math.min(c.y0, py); c.y1 = Math.max(c.y1, py);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = pxx + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx]) continue;
        if (px(nx, ny) > th) { seen[ny * W + nx] = 1; st.push(ny * W + nx); }
      }
    }
    const ch = c.y1 - c.y0 + 1;
    if (ch > cap * 0.95) continue; // a letter
    if ((c.x0 === 0 || c.x1 === W - 1) && ch > cap * 0.6) continue; // clipped letter fragment
    if (!best || c.n > best.n) best = c;
  }
  if (!best) return { separator: null, confidence: 0, why: "no blob" };
  const h = best.y1 - best.y0 + 1, w = best.x1 - best.x0 + 1;
  const rel = h / cap, fill = best.n / (w * h);
  if (rel > 0.92) return { separator: null, rel: +rel.toFixed(3), confidence: 0, why: "letter-sized blob" }; // stars measured <= 0.86
  return {
    separator: rel >= starMin ? "star" : "dot",
    rel: +rel.toFixed(3), fill: +fill.toFixed(3), cap,
    confidence: +Math.min(1, Math.abs(rel - starMin) / 0.08).toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// Public pipeline entry points

/** One OCR pass over a region of the strip (dark-on-light for tesseract, light-on-dark for the classifier). */
async function collectorPass(gray, region, opts) {
  const crop = shrink(cropFrac(gray, ...region), MAX_STRIP_WIDTH);
  const darkBg = median(crop) < 128;
  const forTess = darkBg ? invert(crop) : crop;
  const lightOnDark = darkBg ? crop : invert(crop);
  const ocr = await ocrImage(encodePgm(forTess), { lang: "eng", psm: 6 });
  const parsed = parseCollectorText(ocr.lines, opts);
  if (parsed.setLine != null && parsed.langCode) {
    const sep = classifySeparator(lightOnDark, ocr.lines.filter((l) => l.text.trim())[parsed.setLine], opts);
    parsed.separator = sep.separator;
    parsed.separatorConfidence = sep.confidence;
    parsed.separatorRel = sep.rel ?? null;
    parsed.separatorWhy = sep.why ?? null;
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
 *   separatorRel, confidence, passes, ms}>}
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
  return { ...best, separatorRel: best.separatorRel ?? null, passes, ms: Math.round(performance.now() - t0) };
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
