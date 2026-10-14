// Scanner staging list ("scans"), binders, and committing scans to the
// collection or a deck, the way ManaBox does it: every scan lands in a list
// first, the user fixes printing / finish / quantity / condition there, then
// adds a selection to a binder or a deck.
//
// Guards against ManaBox's classic failure (the same card counted again and
// again): a scan of the same stored printing + finish right after itself is
// NOT staged; the caller gets {duplicate: true} and offers "+1" instead.
// Committed rows go into `collection` with source 'scan', so a ManaBox
// "replace" import (source 'manabox') never deletes them.
//
// Calibration: scans can carry the user's confirmed truth next to the raw
// features of the identification, so thresholds can be re-fit from real photos.
//
// Capture log (v0.5.0): the browser's CaptureController decides when a photo
// is taken. Its decision record (fingerprint distances, arm sources, the
// silent decisions since the last upload in prev[]) rides along with the
// scan into features.capture, "+1 same card?" chip answers and duplicate
// answers go into features.capture_events, and records of scans that are
// never staged (undone, failed) land in the meta ring buffer capture_dropped.
// captureLog() exports all of it so the capture thresholds can be re-fit.
// Records are whitelisted (sanitizeCapture): the features column must stay
// small and free of arbitrary client JSON.

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { eurOf, getAppMeta, setAppMeta, transaction, upsertCards } from "./db.js";
import { BOARDS, saveDeckRows } from "./decks.js";
import { ensureBinder, findBinder } from "./binders.js";
import { scryfall, normalizeCard } from "./scryfall.js";
import * as indexModule from "./cardindex.js";
import { STORE_AS_SCANNED } from "./cardindex.js";
import { finishFromLine } from "./scanner.js";

export const SCAN_DUPLICATE_WINDOW_MS = Number(process.env.SCAN_DUPLICATE_WINDOW_MS) || 20000;
export const CONDITIONS = ["mint", "near_mint", "excellent", "good", "light_played", "played", "poor"];
export const FINISHES = ["normal", "foil", "etched"];

/** Directory for stored scan JPEGs (env SCAN_IMAGE_DIR, else <db dir>/scans). */
export const defaultImageDir = () =>
  process.env.SCAN_IMAGE_DIR || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "scans");

// Stored image names are plain file names in the image dir (a restored backup
// must never point a scan at another file).
const safeFile = (f) => typeof f === "string" && f !== "" && path.basename(f) === f && f !== "." && f !== "..";

/** Error with an HTTP status for the API layer. */
export class ScanError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const parse = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
const FINISH_OF = (f) => (f === "nonfoil" ? "normal" : f);
/** Accept Scryfall's "nonfoil" for the collection's "normal". */
export const normFinish = (f) => (f == null ? f : FINISH_OF(String(f)));
const finishesOf = (p) => (p?.finishes?.length ? p.finishes : ["nonfoil"]).map(FINISH_OF);

/** API view of a scans row (JSON columns parsed; features only on request). */
export function scanRow(r, { features = false } = {}) {
  if (!r) return null;
  const out = {
    ...r,
    finishes: parse(r.finishes, []),
    candidates: parse(r.candidates, []),
    variants: parse(r.variants, []),
    calibration: Boolean(r.calibration),
    calibration_truth: parse(r.calibration_truth, null),
    committed_to: parse(r.committed_to, null),
    has_image: Boolean(r.image_path),
    has_strip: Boolean(r.strip_path),
    result_status: r.match_status, // alias: auto | suggest | review | confirmed | manual
  };
  delete out.strip_path;
  if (features) out.features = parse(r.features, null);
  else delete out.features;
  return out;
}

function getRow(db, id) {
  return db.prepare("SELECT * FROM scans WHERE id = ?").get(Number(id));
}

function requireStaged(db, id) {
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  if (row.status !== "staged") throw new ScanError(409, "Scan is already committed");
  return row;
}

/** Scans by list state: staged (default), committed or all; newest first. */
export function listScans(db, { status = "staged", limit = 500 } = {}) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const args = status === "all" ? [] : [status === "committed" ? "committed" : "staged"];
  return db.prepare(`SELECT * FROM scans ${where} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Math.max(1, limit), 5000))
    .map((r) => scanRow(r));
}

/**
 * Adds `price_eur` (number|null) to scan rows (store printing + finish) and
 * returns the list totals {cards, copies, value_eur, unpriced}: the scanner's
 * running value of the staged list. Same order as scanner.js scanPriceEur:
 * index price, the app `cards` row, then the English twin (index, cards).
 * `indexPrices(items)` is cardindex printingPricesEur run off the main thread
 * (async; a failure only drops to the cards table). One cards query per call.
 */
export async function priceScans(db, rows, { indexPrices = null } = {}) {
  const priced = rows.filter((r) => r.store_printing_id && r.match_status !== "failed");
  const items = priced.map((r) => ({ id: r.store_printing_id, finish: FINISH_OF(r.finish || "normal") }));
  let fromIndex = [];
  if (indexPrices && items.length) {
    try { fromIndex = (await indexPrices(items)) || []; } catch { fromIndex = []; }
  }
  const ids = new Set(items.map((i) => i.id));
  for (const x of fromIndex) if (x?.en_id) ids.add(x.en_id);
  const cardPrices = new Map();
  if (ids.size) {
    const q = db.prepare("SELECT scryfall_id, prices FROM cards WHERE scryfall_id IN (SELECT value FROM json_each(?))");
    for (const r of q.all(JSON.stringify([...ids]))) {
      try { cardPrices.set(r.scryfall_id, JSON.parse(r.prices || "{}")); } catch { /* bad JSON: unpriced */ }
    }
  }
  // A cards row's own price, else the English twin's copied into it (lib/prices.js).
  const fromCards = (id, finish) => {
    const p = cardPrices.get(id);
    return p ? eurOf(p, finish === "etched" ? "eur_etched" : finish === "foil" ? "eur_foil" : "eur") : null;
  };
  const price = new Map();
  priced.forEach((r, i) => {
    const { id, finish } = items[i];
    const x = fromIndex[i]?.id === id ? fromIndex[i] : null;
    const v = x?.eur ?? fromCards(id, finish) ?? x?.en_eur ?? (x?.en_id ? fromCards(x.en_id, finish) : null);
    price.set(r, v ?? null);
  });
  let copies = 0;
  let value = 0;
  let unpriced = 0;
  for (const r of rows) {
    r.price_eur = price.get(r) ?? null;
    const qty = Number(r.quantity) || 0;
    copies += qty;
    if (r.price_eur == null) unpriced += 1;
    else value += qty * r.price_eur;
  }
  return { cards: rows.length, copies, value_eur: Math.round(value * 100) / 100, unpriced };
}

export function getScan(db, id, opts) {
  return scanRow(getRow(db, id), opts);
}

/** Absolute path of a scan's stored card image, or null. */
export function scanImagePath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return safeFile(row?.image_path) ? path.join(imageDir, row.image_path) : null;
}

/** Absolute path of a scan's stored collector-line strip (the high-res bottom crop), or null. */
export function scanStripPath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return safeFile(row?.strip_path) ? path.join(imageDir, row.strip_path) : null;
}

function removeFiles(row, imageDir) {
  for (const f of [row.image_path, row.strip_path]) {
    if (!safeFile(f)) continue;
    try { unlinkSync(path.join(imageDir, f)); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Capture records (public/capture.js CaptureController)

/** Size cap of one sanitized capture record (JSON bytes). */
export const CAPTURE_MAX_BYTES = 4096;
/** Silent decisions carried in a record's prev[]. */
export const CAPTURE_PREV_MAX = 10;
/** Chip answers / duplicate answers kept per scan in features.capture_events. */
export const CAPTURE_EVENTS_MAX = 20;
/** Records of never-staged captures kept in meta capture_dropped. */
export const CAPTURE_DROPPED_MAX = 200;

// Field whitelist: key -> kind. num = finite number (rounded), bool, enum =
// short token, enums/nums = bounded arrays, an object = nested whitelist.
// Unknown keys are dropped; a wrong type drops just that key.
const CAPTURE_SUB = {
  evidence: { card: "bool", empty: "bool", weak: "num", d_empty: "num", d_top: "num" },
  pending: { waited_ms: "num", d_recheck: "num", dropped: "bool", replaced: "bool" },
  chip: { label: "enum", d: "num", d_cap: "num", calibration: "bool" },
};
const CAPTURE_FIELDS = {
  id: "num", kind: "enum", d: "num", d_cap: "num", armed: "enums", watch: "bool", fallback: "bool", quad_source: "enum",
  mad: "num", sharp: "num", variants: "num", calibration: "bool", allow_claude: "bool", watch_checks: "nums",
  evidence: CAPTURE_SUB.evidence, pending: CAPTURE_SUB.pending, chip: CAPTURE_SUB.chip,
  // context the UI may add (detector, orientation, timing, queue)
  det: "enum", state: "enum", orient_conf: "num", jitter: "num", prior_learned: "bool", prior_used: "bool", held: "bool",
  t: "num", ms: "num", queue_ms: "num", queue_len: "num", flushed: "bool", force: "bool", dup_of: "num", source: "enum",
  shot: "enum", strip_w: "num",
};
const ARRAY_MAX = 12;
const isPlain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const cleanNum = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : undefined);
const cleanEnum = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,32}$/.test(v) ? v : undefined);

function cleanFields(raw, spec) {
  const out = {};
  for (const [k, kind] of Object.entries(spec)) {
    const v = raw[k];
    if (v === undefined) continue;
    let c;
    if (v === null) c = null;
    else if (kind === "num") c = cleanNum(v);
    else if (kind === "bool") c = typeof v === "boolean" ? v : undefined;
    else if (kind === "enum") c = cleanEnum(v);
    else if (kind === "enums" || kind === "nums") {
      if (Array.isArray(v)) c = v.slice(0, ARRAY_MAX).map(kind === "enums" ? cleanEnum : cleanNum).filter((x) => x !== undefined);
    } else if (isPlain(kind)) c = isPlain(v) ? cleanFields(v, kind) : undefined;
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Whitelist a capture decision record from the client: known fields only
 * (numbers rounded, short enum tokens, bounded arrays), prev[] <= 10 records
 * (the newest kept, no nesting), at most CAPTURE_MAX_BYTES of JSON (older
 * prev entries go first). Returns the clean object, or null for a non-object.
 */
export function sanitizeCapture(raw) {
  if (!isPlain(raw)) return null;
  const out = cleanFields(raw, CAPTURE_FIELDS);
  if (Array.isArray(raw.prev)) {
    const prev = raw.prev.slice(-CAPTURE_PREV_MAX).filter(isPlain).map((r) => cleanFields(r, CAPTURE_FIELDS));
    if (prev.length) out.prev = prev;
  }
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (out.prev?.length && size() > CAPTURE_MAX_BYTES) out.prev.shift();
  if (out.prev && !out.prev.length) delete out.prev;
  if (size() > CAPTURE_MAX_BYTES) return { kind: out.kind ?? null, truncated: true };
  return out;
}

const featuresOf = (row) => {
  const f = parse(row.features, null);
  return isPlain(f) ? f : {};
};

// Append an event to a scan's features.capture_events (newest CAPTURE_EVENTS_MAX kept).
function appendCaptureEvent(db, row, event) {
  const f = featuresOf(row);
  const events = Array.isArray(f.capture_events) ? f.capture_events : [];
  events.push(event);
  f.capture_events = events.slice(-CAPTURE_EVENTS_MAX);
  db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), row.id);
}

// A capture record whose scan never became (or stopped being) a row: meta ring buffer.
function recordDropped(db, entry) {
  if (!entry.capture) return;
  try {
    const list = parse(getAppMeta(db, "capture_dropped"), []);
    const ring = Array.isArray(list) ? list : [];
    ring.push({ at: nowIso(), ...entry });
    setAppMeta(db, "capture_dropped", JSON.stringify(ring.slice(-CAPTURE_DROPPED_MAX)));
  } catch (err) {
    console.warn(`[scans] capture record not kept: ${err.message}`);
  }
}

/**
 * Every capture record: features.capture + capture_events of every scan
 * (staged and committed) that has one, plus the dropped records (undone or
 * never staged). For re-fitting the capture thresholds offline.
 */
export function captureLog(db) {
  const scans = [];
  for (const r of db.prepare("SELECT * FROM scans ORDER BY id").all()) {
    const f = featuresOf(r);
    if (!f.capture && !f.capture_events) continue;
    scans.push({
      id: r.id, status: r.status, match_status: r.match_status, created_at: r.created_at, printing_id: r.printing_id ?? null,
      store_printing_id: r.store_printing_id ?? null, name: r.name ?? null, finish: r.finish, quantity: r.quantity,
      calibration_truth: parse(r.calibration_truth, null), dup_of: f.dup_of ?? null,
      capture: f.capture ?? null, capture_events: f.capture_events ?? [],
    });
  }
  const dropped = parse(getAppMeta(db, "capture_dropped"), []);
  return { scans, dropped: Array.isArray(dropped) ? dropped : [] };
}

// Columns derived from the detected printing and its storage-language twin.
function printingColumns(printing, store) {
  const s = store || printing;
  return {
    printing_id: printing.id,
    store_printing_id: s.id,
    oracle_id: s.oracle_id ?? printing.oracle_id ?? null,
    name: s.name ?? printing.name,
    printed_name: s.printed_name ?? null,
    set_code: s.set_code,
    set_name: s.set_name ?? null,
    collector_number: s.collector_number,
    rarity: s.rarity ?? null,
    image_small: s.image_small ?? s.faces?.[0]?.image_small ?? printing.image_small ?? null,
    image_normal: s.image_normal ?? s.faces?.[0]?.image_normal ?? printing.image_normal ?? null,
    finishes: JSON.stringify(s.finishes?.length ? s.finishes : printing.finishes || []),
    lang_detected: printing.lang ?? null,
    store_lang: s.lang ?? null,
  };
}

/**
 * Stage an identify() result. Returns {scan, duplicate}. A failed result (no
 * printing) is not staged ({scan: null}), except in calibration mode, where it
 * becomes an uncommittable 'failed' row so the truth attaches to the real
 * attempt. Same stored printing + finish as the most recent scan within
 * SCAN_DUPLICATE_WINDOW_MS (and no `force`) is not staged either:
 * {duplicate: true, scan: <that scan>}; for REVIEW results the key is the
 * detected printing of the most recent REVIEW scan. `replaceId` names a staged
 * review/failed scan that this one replaces (the UI's "Rescan").
 * `dupOf` (the capture chip's held photo that the user ignored) names the row
 * the client thinks this is a copy of: if that row is still staged with the
 * same stored printing (any finish), or for REVIEW the same detected
 * printing, the answer is {duplicate: true, scan: <that row>} whatever the
 * window or match_status. `capture` (raw client record, sanitized here) goes
 * into features.capture, on a duplicate answer into that row's
 * capture_events, for a failed result into meta capture_dropped.
 * `probe` ({session}) marks a row staged by a recognition probe (features.probe).
 * opts: {image, strip, force, condition, calibration, replaceId, dupOf, capture, probe, imageDir, windowMs, now}
 */
export function stageScan(db, result, opts = {}) {
  const { image = null, strip = null, force = false, calibration = false, imageDir = defaultImageDir(), windowMs = SCAN_DUPLICATE_WINDOW_MS } = opts;
  const now = opts.now ?? Date.now();
  const failed = !result?.printing || result.status === "failed";
  const capture = opts.capture == null ? null : sanitizeCapture(opts.capture);
  if (failed && !(calibration && result)) {
    if (capture) recordDropped(db, { reason: "failed", result_status: "failed", capture });
    return { scan: null, duplicate: false };
  }
  const store = failed ? null : result.store || result.printing;
  const finish = FINISHES.includes(normFinish(result.finish)) ? normFinish(result.finish) : "normal";
  const condition = CONDITIONS.includes(opts.condition) ? opts.condition : "near_mint";

  if (opts.replaceId != null) {
    const old = getRow(db, opts.replaceId);
    if (old && old.status === "staged" && ["review", "failed"].includes(old.match_status)) {
      db.prepare("DELETE FROM scans WHERE id = ?").run(old.id);
      removeFiles(old, imageDir);
    }
  }

  const dupAnswer = (row, rule) => {
    if (capture) appendCaptureEvent(db, row, { at: new Date(now).toISOString(), event: "duplicate", rule, capture });
    return { scan: scanRow(getRow(db, row.id)), duplicate: true };
  };
  if (!force && !failed && opts.dupOf != null) {
    const target = getRow(db, opts.dupOf);
    const same = target?.status === "staged" && (result.status === "review"
      ? target.printing_id === result.printing.id
      : target.store_printing_id === store.id && target.finish === finish); // a foil copy is not a +1 of a non-foil row
    if (same) return dupAnswer(target, "dup_of");
  }
  if (!force && !failed) {
    const last = db.prepare("SELECT * FROM scans WHERE status = 'staged' ORDER BY updated_at DESC, id DESC LIMIT 1").get();
    const recent = last && now - Date.parse(last.updated_at) < windowMs;
    const same = result.status === "review"
      ? last?.match_status === "review" && last.printing_id === result.printing.id
      : last?.store_printing_id === store.id && last?.finish === finish;
    if (recent && same) return dupAnswer(last, "window");
  }

  const features = {
    ...(result.features || {}),
    result: {
      status: failed ? "failed" : result.status, printing_id: result.printing?.id ?? null, store_printing_id: store?.id ?? null, finish,
      finish_source: result.finishSource ?? null, method: result.method ?? null, confidence: result.confidence ?? null,
      claude_used: Boolean(result.claude_used), timings: result.timings ?? null,
    },
  };
  if (capture) features.capture = capture;
  if (opts.probe) features.probe = { session: opts.probe.session ?? null };
  if (opts.dupOf != null && Number.isInteger(Number(opts.dupOf))) features.dup_of = Number(opts.dupOf);
  const ts = new Date(now).toISOString();
  const cols = {
    created_at: ts,
    updated_at: ts,
    status: "staged",
    match_status: failed ? "failed" : result.status === "manual" ? "manual" : result.status,
    ...(failed ? {} : printingColumns(result.printing, store)),
    finish,
    finish_source: result.finishSource ?? null,
    condition,
    quantity: Math.max(1, Math.min(999, parseInt(result.quantity, 10) || 1)),
    confidence: result.confidence ?? null,
    method: result.method ?? null,
    candidates: JSON.stringify(result.candidates || []),
    variants: JSON.stringify(result.variants || []),
    features: JSON.stringify(features),
    calibration: calibration ? 1 : 0,
    last_action: "stage",
  };
  const keys = Object.keys(cols);
  const id = Number(db.prepare(`INSERT INTO scans (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid);

  if (image || strip) {
    try {
      mkdirSync(imageDir, { recursive: true });
      let imagePath = null, stripPath = null;
      // A random token in the name: scan ids are reused (a restore of an older
      // backup lowers max(id)), and a new scan must never overwrite or later
      // delete the photo of a scan that a (safety) backup still points to.
      const base = `scan-${id}-${crypto.randomBytes(6).toString("hex")}`;
      if (image) { imagePath = `${base}.jpg`; writeFileSync(path.join(imageDir, imagePath), image, { flag: "wx" }); }
      // The strip is the user's own collector line: the printing picker shows it
      // zoomed in, and calibration re-runs OCR on it.
      if (strip) { stripPath = `${base}-strip.jpg`; writeFileSync(path.join(imageDir, stripPath), strip, { flag: "wx" }); }
      db.prepare("UPDATE scans SET image_path = ?, strip_path = ? WHERE id = ?").run(imagePath, stripPath, id);
    } catch (err) {
      console.warn(`[scans] could not store the image of scan ${id}: ${err.message}`);
    }
  }
  return { scan: getScan(db, id), duplicate: false };
}

/**
 * Edit a staged scan. A new printing_id or store_lang re-derives the stored
 * printing from the local index (ctx.idx); the scan then counts as confirmed.
 * A scan staged with the storage language "scanned" (STORE_AS_SCANNED, the
 * default) stores the picked printing itself; store_lang may also be "scanned".
 */
export function updateScan(db, id, patch = {}, { idx, index = indexModule } = {}) {
  const row = requireStaged(db, id);
  const set = {};
  if (patch.printing_id != null || patch.store_lang != null) {
    if (!idx) throw new ScanError(503, "The card index is not available");
    const asScanned = featuresOf(row).settings?.storageLang === STORE_AS_SCANNED;
    const storeLang = patch.store_lang != null ? String(patch.store_lang).toLowerCase() : asScanned ? STORE_AS_SCANNED : row.store_lang || "en";
    if (storeLang !== STORE_AS_SCANNED && !/^[a-z]{2,3}$/.test(storeLang)) throw new ScanError(400, "store_lang must be a language code or \"scanned\"");
    const printing = index.getPrinting(idx, patch.printing_id != null ? String(patch.printing_id) : row.printing_id);
    if (!printing) throw new ScanError(400, "Unknown printing");
    const store = storeLang === STORE_AS_SCANNED ? printing : index.storagePrinting(idx, printing, storeLang) || printing;
    Object.assign(set, printingColumns(printing, store));
    set.store_lang = store.lang;
    if (patch.printing_id != null) set.match_status = "confirmed";
    const fins = finishesOf(store);
    if (patch.finish == null && patch.printing_id != null && row.finish_source !== "user") {
      // A new printing re-decides the finish from the stored ★/• read (beta.1 kept the old
      // printing's finish, so a ★ on a card first matched to a non-foil-only printing stayed normal).
      const f = featuresOf(row);
      const fin = finishFromLine(printing, f.collector ?? null, { foilMode: f.settings?.foil ?? "auto" });
      if (fins.includes(fin.finish) && (fin.finish !== row.finish || fin.source !== row.finish_source)) {
        set.finish = fin.finish;
        set.finish_source = fin.source;
      }
    }
    // Keep the finish if the new printing has it; else its only finish / normal.
    if (patch.finish == null && !fins.includes(set.finish ?? row.finish)) set.finish = fins.includes("normal") ? "normal" : fins[0];
  }
  if (patch.finish != null) {
    const f = normFinish(patch.finish);
    if (!FINISHES.includes(f)) throw new ScanError(400, `finish must be one of ${FINISHES.join(", ")}`);
    const fins = parse(set.finishes ?? row.finishes, []).map(FINISH_OF);
    if (fins.length && !fins.includes(f)) throw new ScanError(400, `This printing has no ${f} finish`);
    set.finish = f;
    set.finish_source = "user";
  }
  if (patch.quantity != null) {
    const q = Number(patch.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 999) throw new ScanError(400, "quantity must be 1-999");
    set.quantity = q;
  }
  if (patch.condition != null) {
    if (!CONDITIONS.includes(patch.condition)) throw new ScanError(400, `condition must be one of ${CONDITIONS.join(", ")}`);
    set.condition = patch.condition;
  }
  if (patch.confirm === true && row.match_status !== "confirmed") set.match_status = "confirmed";
  const keys = Object.keys(set);
  if (keys.length) {
    // The edit becomes the last action; undo restores exactly these columns.
    const prev = Object.fromEntries([...keys, "last_action", "updated_at"].map((k) => [k, row[k]]));
    set.undo = JSON.stringify(prev);
    set.last_action = "edit";
    set.updated_at = nowIso();
    const all = Object.keys(set);
    db.prepare(`UPDATE scans SET ${all.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...all.map((k) => set[k]), row.id);
  }
  return getScan(db, row.id);
}

/** Delete a staged scan (and its images). */
export function deleteScan(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  db.prepare("DELETE FROM scans WHERE id = ?").run(row.id);
  removeFiles(row, imageDir);
  return { deleted: row.id };
}

/**
 * +1 copy of a staged scan (the "scan again" / duplicate path). An optional
 * `capture` record (the chip answer) is appended to features.capture_events
 * with the quantity it led to, so undoing this +1 drops it again.
 */
export function incrementScan(db, id, { capture = null } = {}) {
  const row = requireStaged(db, id);
  const ts = nowIso();
  db.prepare("UPDATE scans SET quantity = MIN(999, quantity + 1), last_action = 'increment', undo = NULL, updated_at = ? WHERE id = ?").run(ts, row.id);
  const c = capture == null ? null : sanitizeCapture(capture);
  if (c) {
    const fresh = getRow(db, row.id);
    appendCaptureEvent(db, fresh, { at: ts, event: "increment", q: fresh.quantity, capture: c });
  }
  return getScan(db, row.id);
}

// Undo of a +1 down to quantity q: the increment events above q go too.
function dropIncrementEvents(db, row, q) {
  const f = featuresOf(row);
  if (!Array.isArray(f.capture_events)) return;
  const keep = f.capture_events.filter((e) => !(e?.event === "increment" && Number(e.q) > q));
  if (keep.length === f.capture_events.length) return;
  f.capture_events = keep;
  db.prepare("UPDATE scans SET features = ? WHERE id = ?").run(JSON.stringify(f), row.id);
}

/**
 * Undo the last scan action: a +1 is taken back (quantity - 1), an edit
 * (quantity, finish, printing, condition) is reverted, a fresh scan is
 * removed. Returns {undone: 'decrement'|'revert'|'delete'|null, scan}.
 */
export function undoLast(db, { imageDir = defaultImageDir() } = {}) {
  const last = db.prepare("SELECT * FROM scans WHERE status = 'staged' ORDER BY updated_at DESC, id DESC LIMIT 1").get();
  if (!last) return { undone: null, scan: null };
  if (last.last_action === "edit") {
    const prev = parse(last.undo, null);
    if (!prev || typeof prev !== "object") {
      // Nothing to restore: never delete a scan the user just edited.
      db.prepare("UPDATE scans SET last_action = 'stage' WHERE id = ?").run(last.id);
      return { undone: null, scan: getScan(db, last.id) };
    }
    const cols = Object.keys(prev).filter((k) => /^[a-z_]+$/.test(k) && k !== "id" && k !== "undo");
    db.prepare(`UPDATE scans SET ${cols.map((k) => `${k} = ?`).join(", ")}, undo = NULL WHERE id = ?`)
      .run(...cols.map((k) => prev[k] ?? null), last.id);
    return { undone: "revert", scan: getScan(db, last.id) };
  }
  if (last.last_action === "increment" && last.quantity > 1) {
    const q = last.quantity - 1;
    db.prepare("UPDATE scans SET quantity = ?, last_action = ?, undo = NULL WHERE id = ?").run(q, q > 1 ? "increment" : "stage", last.id);
    dropIncrementEvents(db, last, q);
    return { undone: "decrement", scan: getScan(db, last.id) };
  }
  // The capture record outlives the row (an undone "new card" is a label too).
  const f = featuresOf(last);
  if (f.capture) {
    recordDropped(db, {
      reason: "undo", scan_id: last.id, result_status: last.match_status, printing_id: last.printing_id ?? null,
      store_printing_id: last.store_printing_id ?? null, capture: f.capture, capture_events: f.capture_events ?? [],
    });
  }
  db.prepare("DELETE FROM scans WHERE id = ?").run(last.id);
  removeFiles(last, imageDir);
  return { undone: "delete", scan: scanRow(last) };
}

// ---------------------------------------------------------------------------
// Recognition probes (v0.5.0 beta.2, "recognition-driven capture")
//
// While a card-like thing is in view the browser sends a probe (~1/s); the
// server identifies it locally (OCR + fingerprint, never Claude) and stages
// it only when it is identified (auto/suggest) AND differs from the card this
// probe session staged last (store printing; the finish only upgrades that
// row, see finishUpgrade). The same card again is
// ignored silently (decision 12: the user taps +1); an unidentified probe
// leaves nothing behind but a counter. The "last card" is the detected key,
// remembered per session in memory, so a Discard (DELETE), an undo or a
// printing fix of that row never makes the card still lying in the box come
// back a second later; after a restart it comes from the newest row of that
// session (features.probe.session + features.result). Probes never queue: a
// full identify slot answers 'busy' at once and the client simply probes
// again. They skip the duplicate window (they have their own rule) and never
// touch the last row's updated_at, so the window of normal scans stays as is.

/** Probe session ids: client-generated, [A-Za-z0-9-]{1,40}. */
export const PROBE_SESSION_RE = /^[A-Za-z0-9-]{1,40}$/;
/** Identified statuses a probe stages. */
export const PROBE_STAGE_STATUSES = ["auto", "suggest"];
/** Counted outcomes of a probe. */
export const PROBE_OUTCOMES = ["staged", "same", "unidentified", "busy", "error"];
const PROBE_SESSIONS_MAX = 64;
const PROBE_MINUTES = 10;

/**
 * Shared identify slots (SCAN_MAX_CONCURRENT): normal scans and probes take
 * one each; tryAcquire() never waits.
 */
export function createScanSlots(max) {
  let used = 0;
  return {
    max,
    get used() { return used; },
    tryAcquire() { if (used >= max) return false; used++; return true; },
    release() { used = Math.max(0, used - 1); },
  };
}

/** Store printing + finish key of an identified result (null when nothing was identified). */
export function probeKey(result) {
  const store = result?.store || result?.printing;
  if (!store?.id || result.status === "failed") return null;
  const f = normFinish(result.finish);
  return { store_printing_id: store.id, finish: FINISHES.includes(f) ? f : "normal" };
}

/**
 * A 'same' probe with a confident ★/• read (finish source 'star') fixes the
 * finish of the staged row it repeats when that row's finish was only a guess
 * (session toggle / unknown) and the user hasn't set it: finish voting across
 * probes of one card. The row's undo/last_action stay as they are. Returns
 * the updated scan, or null when nothing changed.
 */
export function finishUpgrade(db, scanId, result, key) {
  if (scanId == null || result?.finishSource !== "star") return null;
  const row = getRow(db, scanId);
  if (!row || row.status !== "staged" || row.store_printing_id !== key.store_printing_id) return null;
  if (row.finish_source === "user" || row.finish_source === "star" || row.finish_source === "finishes") return null;
  if (!parse(row.finishes, []).map(FINISH_OF).includes(key.finish)) return null;
  db.prepare("UPDATE scans SET finish = ?, finish_source = 'star' WHERE id = ?").run(key.finish, row.id);
  return getScan(db, row.id);
}

/**
 * Probe runner: session memory, the busy rule and per-minute outcome
 * counters (/healthz). `slots` = createScanSlots() shared with normal scans;
 * `warming()` true answers 'busy' while the fingerprint matcher is still
 * loading (a probe must not hold a slot for SCAN_MATCHER_WAIT_MS).
 */
export class ProbeRunner {
  constructor({ slots, warming = () => false, now = () => Date.now() } = {}) {
    this.slots = slots;
    this.warming = warming;
    this.now = now;
    this.sessions = new Map(); // session -> {store_printing_id, finish, scan_id, at}; LRU order
    this.inFlight = new Set(); // sessions with a probe running
    this.minutes = []; // [{t (minute start, ms), staged, same, unidentified, busy, error}]
    this.totals = Object.fromEntries(PROBE_OUTCOMES.map((k) => [k, 0]));
  }

  count(outcome) {
    const t = Math.floor(this.now() / 60000) * 60000;
    let m = this.minutes.at(-1);
    if (!m || m.t !== t) {
      m = { t, ...Object.fromEntries(PROBE_OUTCOMES.map((k) => [k, 0])) };
      this.minutes.push(m);
      while (this.minutes[0].t <= t - PROBE_MINUTES * 60000) this.minutes.shift();
    }
    m[outcome]++;
    this.totals[outcome]++;
  }

  /** Compact counters for /healthz: totals since start + the last 10 minutes (oldest first, idle minutes left out). */
  stats() {
    const since = Math.floor(this.now() / 60000) * 60000 - (PROBE_MINUTES - 1) * 60000;
    return {
      totals: { ...this.totals },
      per_minute: this.minutes.filter((m) => m.t >= since).map((m) => ({ ...m, t: new Date(m.t).toISOString() })),
      sessions: this.sessions.size,
      in_flight: this.inFlight.size,
    };
  }

  remember(session, key, scanId) {
    if (!session || !key) return;
    this.sessions.delete(session);
    this.sessions.set(session, { store_printing_id: key.store_printing_id, finish: key.finish, scan_id: scanId ?? null, at: this.now() });
    while (this.sessions.size > PROBE_SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value);
  }

  /**
   * A normal scan (shutter, Rescan, Ask Claude) that carried the probe
   * session: its identified card (staged or a duplicate answer) becomes the
   * session's last card, so the next probe doesn't stage it a second time.
   */
  noteScan(session, result, scan) {
    if (!session || !scan) return;
    const key = probeKey(result);
    if (key && PROBE_STAGE_STATUSES.includes(result.status)) this.remember(session, key, scan.id);
  }

  // The card to compare against: the session's memory, else the newest row
  // of the session (after a restart), else the newest staged scan.
  lastKey(db, session) {
    if (session) {
      const mem = this.sessions.get(session);
      if (mem) return mem;
      const row = db.prepare(`SELECT id, features FROM scans WHERE json_extract(features, '$.probe.session') = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(session);
      const r = row ? featuresOf(row).result : null;
      if (r?.store_printing_id) return { store_printing_id: r.store_printing_id, finish: r.finish ?? "normal", scan_id: row.id };
    }
    const last = db.prepare("SELECT id, store_printing_id, finish FROM scans WHERE status = 'staged' ORDER BY updated_at DESC, id DESC LIMIT 1").get();
    return last?.store_printing_id ? { store_printing_id: last.store_printing_id, finish: last.finish, scan_id: last.id } : null;
  }

  /**
   * Run one probe. `identify()` is the local identification (the caller makes
   * sure it cannot reach Claude); it only starts when a slot is free.
   * Returns {outcome, reason?, scan, result}: 'staged' (scan = the new row),
   * 'same' (nothing staged; scan = the repeated row when a ★/• read upgraded
   * its finish, + finish_upgraded), 'unidentified' (nothing stored), 'busy' (identify not run;
   * reason 'warming_up' | 'session' (this session's previous probe still
   * runs) | 'slots'), 'cancelled' (signal aborted during identify: nothing
   * staged, not counted). identify() errors are counted and rethrown.
   * opts: {session, image, strip, condition, capture, imageDir, signal, now}
   */
  async run(db, identify, opts = {}) {
    const session = opts.session ?? null;
    const busy = (reason) => { this.count("busy"); return { outcome: "busy", reason, scan: null, result: null }; };
    if (this.warming()) return busy("warming_up");
    if (session && this.inFlight.has(session)) return busy("session");
    if (!this.slots.tryAcquire()) return busy("slots");
    if (session) this.inFlight.add(session);
    let result;
    try {
      result = await identify();
    } catch (err) {
      this.count("error");
      throw err;
    } finally {
      this.slots.release();
      if (session) this.inFlight.delete(session);
    }
    if (opts.signal?.aborted) return { outcome: "cancelled", scan: null, result };
    const key = PROBE_STAGE_STATUSES.includes(result?.status) ? probeKey(result) : null;
    if (!key) {
      this.count("unidentified");
      return { outcome: "unidentified", scan: null, result };
    }
    // Synchronous from here on: two probes finishing together can't both stage.
    // Same card = same store printing; the finish is NOT part of the key (★/• reads vary between
    // probes of one card: with it the val2 replay staged 14-56 duplicates). A confident ★/• read
    // upgrades the staged row's finish instead (finishUpgrade).
    const last = this.lastKey(db, session);
    if (last && last.store_printing_id === key.store_printing_id) {
      const upgraded = finishUpgrade(db, last.scan_id, result, key);
      this.remember(session, key, last.scan_id);
      this.count("same");
      return { outcome: "same", scan: upgraded, result, ...(upgraded ? { finish_upgraded: true } : {}) };
    }
    const staged = stageScan(db, result, {
      // A card found upside down is stored turned upright (identifyOriented's re-encode).
      image: result.upright?.card ?? opts.image ?? null, strip: result.upright?.strip ?? opts.strip ?? null, force: true, condition: opts.condition, capture: opts.capture ?? null,
      calibration: opts.calibration === true, probe: { session }, imageDir: opts.imageDir ?? defaultImageDir(), now: opts.now,
    });
    this.remember(session, key, staged.scan?.id);
    this.count("staged");
    return { outcome: "staged", scan: staged.scan, result };
  }
}

// ---------------------------------------------------------------------------
// Committing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch full Scryfall card objects for ids, in /cards/collection batches of
 * 75 spaced 500 ms apart (that endpoint allows 2 req/s). Returns {cards, notFound}.
 */
export async function fetchCardsPolitely(ids) {
  const cards = [];
  const notFound = [];
  for (let i = 0; i < ids.length; i += 75) {
    if (i) await sleep(500);
    const data = await scryfall("/cards/collection", { method: "POST", body: { identifiers: ids.slice(i, i + 75).map((id) => ({ id })) } });
    cards.push(...(data.data || []));
    notFound.push(...(data.not_found || []));
  }
  return { cards, notFound };
}

/** fetched_at of a cards row built from the local index: re-fetched from Scryfall at the next chance. */
export const FALLBACK_FETCHED_AT = "";

// A cards row from the local index, for when Scryfall can't be reached. The
// index has no colours or legalities: colours are approximated from the mana
// cost, the EUR prices come from the index (bulk data, when it has them), and
// the row is marked (FALLBACK_FETCHED_AT) so the next successful commit
// replaces it with Scryfall's data.
function cardRowFromIndex(p) {
  const colors = "WUBRG".split("").filter((c) => String(p.mana_cost || "").includes(c)).join("");
  const prices = {};
  for (const k of ["eur", "eur_foil", "eur_etched"]) if (p[k] != null) prices[k] = String(p[k]);
  return {
    scryfall_id: p.id, oracle_id: p.oracle_id || p.id, name: p.name, set_code: p.set_code, set_name: p.set_name ?? null,
    collector_number: p.collector_number, lang: p.lang, rarity: p.rarity ?? null, type_line: p.type_line ?? null,
    mana_cost: p.mana_cost ?? null, cmc: null, colors, color_identity: colors, oracle_text: null, keywords: "[]",
    legalities: "{}", prices: JSON.stringify(prices), image_small: p.image_small ?? p.faces?.[0]?.image_small ?? null,
    image_normal: p.image_normal ?? p.faces?.[0]?.image_normal ?? null, scryfall_uri: null, fetched_at: FALLBACK_FETCHED_AT,
  };
}

function validateTarget(db, target) {
  if (!target || typeof target !== "object") throw new ScanError(400, "target is required");
  if (target.type === "binder") {
    const name = typeof target.name === "string" ? target.name.trim() : "";
    if (!name) throw new ScanError(400, "target.name (binder) is required");
    if (name.length > 100) throw new ScanError(400, "Binder name is too long (max 100)");
    const existing = findBinder(db, name);
    if (!existing && !target.create) throw new ScanError(404, `Binder "${name}" not found (set create to make it)`);
    return { type: "binder", name: existing ?? name, created: !existing };
  }
  if (target.type === "deck") {
    const board = target.board ?? "main";
    if (!BOARDS.includes(board)) throw new ScanError(400, `target.board must be one of ${BOARDS.join(", ")}`);
    let deck = null;
    if (target.id != null) {
      deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(target.id));
      if (!deck) throw new ScanError(404, "Deck not found");
    } else {
      const name = typeof target.name === "string" ? target.name.trim() : "";
      if (!name) throw new ScanError(400, "target.id or target.name (deck) is required");
      if (name.length > 200) throw new ScanError(400, "Deck name is too long (max 200)");
      deck = db.prepare("SELECT * FROM decks WHERE name = ? COLLATE NOCASE ORDER BY updated_at DESC").get(name);
      if (!deck && !target.create) throw new ScanError(404, `Deck "${name}" not found (set create to make it)`);
      if (!deck) {
        const format = typeof target.format === "string" && target.format.trim() ? target.format.trim().slice(0, 50) : null;
        return { type: "deck", id: null, name, format, board, created: true, owned: target.owned !== false };
      }
    }
    // A ManaBox replace import rebuilds its decks from the CSV and would drop
    // scanned additions: those decks are read-only for the scanner.
    if (deck.source === "manabox") {
      throw new ScanError(409, `Deck "${deck.name}" is synced from ManaBox; add the cards in ManaBox or choose another deck`);
    }
    return { type: "deck", id: deck.id, name: deck.name, format: deck.format, board, created: false, owned: target.owned !== false };
  }
  throw new ScanError(400, 'target.type must be "binder" or "deck"');
}

/**
 * Add staged scans to a binder or a deck.
 * target: {type:'binder', name, create?} | {type:'deck', id? | name, create?, format?, board, owned?}
 * Binder: collection rows (source 'scan'). Deck: deck_cards rows appended to
 * the board, and (unless owned:false) the copies also enter the collection in
 * a binder named after the deck, like a ManaBox deck binder.
 * Card data for the stored printings comes from Scryfall /cards/collection
 * (falls back to the local index offline). Returns {committed, target}.
 */
export async function commitScans(db, ids, target, { idx = null, index = indexModule, imageDir = defaultImageDir(), fetchCards = fetchCardsPolitely } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new ScanError(400, "ids must be a non-empty array");
  if (ids.length > 2000) throw new ScanError(400, "At most 2000 scans per commit");
  const unique = [...new Set(ids.map(Number))];
  if (unique.some((n) => !Number.isInteger(n) || n <= 0)) throw new ScanError(400, "ids must be scan ids");
  const rows = unique.map((id) => {
    const r = getRow(db, id);
    if (!r) throw new ScanError(404, `Scan ${id} not found`);
    if (r.status !== "staged") throw new ScanError(409, `Scan ${id} is already committed`);
    if (r.match_status === "review") throw new ScanError(409, `Scan ${id} (${r.name}) needs review: pick the right printing first`);
    if (!r.store_printing_id) throw new ScanError(409, `Scan ${id} has no printing`);
    return r;
  });
  const t = validateTarget(db, target);

  // Card rows for printings the main DB doesn't know yet.
  const have = new Set();
  const check = db.prepare("SELECT 1 FROM cards WHERE scryfall_id = ?");
  for (const r of rows) if (check.get(r.store_printing_id)) have.add(r.store_printing_id);
  const missing = [...new Set(rows.map((r) => r.store_printing_id))].filter((id) => !have.has(id));
  // Earlier offline fallbacks get Scryfall's data now (no fallback again for them).
  const stale = db.prepare("SELECT scryfall_id FROM cards WHERE fetched_at = ? LIMIT 150").all(FALLBACK_FETCHED_AT)
    .map((r) => r.scryfall_id).filter((id) => !missing.includes(id));
  const cardRows = [];
  if (missing.length || stale.length) {
    let fetched = [];
    try {
      fetched = (await fetchCards([...missing, ...stale])).cards || [];
    } catch (err) {
      console.warn(`[scans] Scryfall lookup failed (${err.message}); using the local index`);
    }
    const got = new Set(fetched.map((c) => c.id));
    cardRows.push(...fetched.map(normalizeCard));
    for (const id of missing.filter((x) => !got.has(x))) {
      const p = idx ? index.getPrinting(idx, id) : null;
      if (!p) throw new ScanError(502, `Card data for ${id} is unavailable (Scryfall unreachable and not in the index)`);
      cardRows.push(cardRowFromIndex(p));
    }
  }

  const committedAt = nowIso();
  const result = transaction(db, () => {
    upsertCards(db, cardRows);
    const nameOf = db.prepare("SELECT name FROM cards WHERE scryfall_id = ?");
    const insert = db.prepare(
      `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source)
       VALUES (?, ?, ?, ?, ?, ?, 'scan')
       ON CONFLICT (scryfall_id, finish, language, condition, binder, source) DO UPDATE SET quantity = quantity + excluded.quantity`,
    );
    let deckId = t.id ?? null;
    // A deck's copies go into the binder of the deck's name, in the spelling that binder already has.
    const binder = t.type === "binder" ? t.name : t.owned ? (findBinder(db, t.name) ?? t.name) : null;
    if (binder != null) {
      ensureBinder(db, binder, "app");
      for (const r of rows) insert.run(r.store_printing_id, r.finish, r.store_lang || "en", r.condition, binder, r.quantity);
    }
    if (t.type === "deck") {
      const deckRows = rows.map((r) => ({
        board: t.board, name: nameOf.get(r.store_printing_id)?.name ?? r.name, scryfall_id: r.store_printing_id, quantity: r.quantity,
      }));
      deckId = saveDeckRows(db, { id: deckId ?? undefined, name: t.name, format: t.format ?? null, source: "scan", rows: deckRows, append: true });
    }
    // A deck commit records whether owned copies were added and where (lib/edits.js relanguageScans).
    const to = JSON.stringify(t.type === "deck"
      ? { type: "deck", id: deckId, name: t.name, board: t.board, owned: Boolean(t.owned), binder }
      : { type: "binder", name: t.name });
    const mark = db.prepare("UPDATE scans SET status = 'committed', committed_at = ?, committed_to = ?, image_path = ?, strip_path = ? WHERE id = ?");
    for (const r of rows) {
      const keep = r.calibration || r.calibration_truth;
      mark.run(committedAt, to, keep ? r.image_path : null, keep ? r.strip_path : null, r.id);
    }
    return { deckId };
  });
  // Images of committed scans are only kept for calibration.
  for (const r of rows) if (!(r.calibration || r.calibration_truth)) removeFiles(r, imageDir);

  const copies = rows.reduce((a, r) => a + r.quantity, 0);
  const outTarget = t.type === "deck"
    ? { type: "deck", id: result.deckId, name: t.name, board: t.board, created: t.created, binder: t.owned ? (findBinder(db, t.name) ?? t.name) : null }
    : { type: "binder", name: t.name, created: t.created };
  return { committed: rows.length, copies, target: outTarget };
}

// ---------------------------------------------------------------------------
// Binders live in lib/binders.js (re-exported for older callers).

export { listBinders, renameBinder, deleteBinder } from "./binders.js";

// ---------------------------------------------------------------------------
// Calibration

/**
 * Record the true printing + finish of a scan (calibration). For a staged scan
 * the scan itself is corrected too.
 */
export function recordTruth(db, id, { printing_id, finish } = {}, { idx, index = indexModule } = {}) {
  finish = normFinish(finish);
  const row = getRow(db, id);
  if (!row) throw new ScanError(404, "Scan not found");
  if (!printing_id) throw new ScanError(400, "printing_id is required");
  if (finish != null && !FINISHES.includes(finish)) throw new ScanError(400, `finish must be one of ${FINISHES.join(", ")}`);
  const p = idx ? index.getPrinting(idx, String(printing_id)) : null;
  if (idx && !p) throw new ScanError(400, "Unknown printing");
  const truth = {
    printing_id: String(printing_id), finish: finish ?? row.finish,
    oracle_id: p?.oracle_id ?? null, name: p?.name ?? null, set_code: p?.set_code ?? null,
    collector_number: p?.collector_number ?? null, lang: p?.lang ?? null, recorded_at: nowIso(),
  };
  db.prepare("UPDATE scans SET calibration_truth = ?, calibration = 1 WHERE id = ?").run(JSON.stringify(truth), row.id);
  if (row.status === "staged" && p) {
    const patch = {};
    if (p.id !== row.printing_id) patch.printing_id = p.id;
    if (finish != null && finish !== row.finish) patch.finish = finish;
    try {
      if (Object.keys(patch).length) updateScan(db, row.id, patch, { idx, index });
      else updateScan(db, row.id, { confirm: true }, { idx, index });
    } catch (err) {
      if (!(err instanceof ScanError)) throw err;
      // e.g. the truth's finish is not in the stored printing: keep the truth anyway.
    }
  }
  return getScan(db, row.id);
}

/** Every scan with a recorded truth: detection result, features and truth. */
export function exportCalibration(db) {
  return db.prepare("SELECT * FROM scans WHERE calibration_truth IS NOT NULL ORDER BY id").all().map((r) => {
    const features = parse(r.features, {});
    const truth = parse(r.calibration_truth, null);
    const detected = features?.result ?? null;
    // Manually staged rows (picked by name) were never detected.
    const manual = Boolean(features?.manual) || detected?.status === "manual";
    return {
      id: r.id,
      created_at: r.created_at,
      truth,
      detected,
      correct_printing: detected && truth && !manual ? detected.printing_id === truth.printing_id : null,
      correct_finish: detected && truth && !manual && detected.printing_id ? detected.finish === truth.finish : null,
      manual,
      features,
    };
  });
}
