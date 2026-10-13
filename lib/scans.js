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

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { transaction, upsertCards } from "./db.js";
import { BOARDS, saveDeckRows } from "./decks.js";
import { scryfall, normalizeCard } from "./scryfall.js";
import * as indexModule from "./cardindex.js";

export const SCAN_DUPLICATE_WINDOW_MS = Number(process.env.SCAN_DUPLICATE_WINDOW_MS) || 20000;
export const CONDITIONS = ["mint", "near_mint", "excellent", "good", "light_played", "played", "poor"];
export const FINISHES = ["normal", "foil", "etched"];

/** Directory for stored scan JPEGs (env SCAN_IMAGE_DIR, else <db dir>/scans). */
export const defaultImageDir = () =>
  process.env.SCAN_IMAGE_DIR || path.join(path.dirname(path.resolve(process.env.DB_FILE || "/data/mtg-planner.db")), "scans");

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

export function getScan(db, id, opts) {
  return scanRow(getRow(db, id), opts);
}

/** Absolute path of a scan's stored card image, or null. */
export function scanImagePath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return row?.image_path ? path.join(imageDir, row.image_path) : null;
}

/** Absolute path of a scan's stored collector-line strip (the high-res bottom crop), or null. */
export function scanStripPath(db, id, { imageDir = defaultImageDir() } = {}) {
  const row = getRow(db, id);
  return row?.strip_path ? path.join(imageDir, row.strip_path) : null;
}

function removeFiles(row, imageDir) {
  for (const f of [row.image_path, row.strip_path]) {
    if (!f) continue;
    try { unlinkSync(path.join(imageDir, f)); } catch { /* already gone */ }
  }
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
 * opts: {image, strip, force, condition, calibration, replaceId, imageDir, windowMs, now}
 */
export function stageScan(db, result, opts = {}) {
  const { image = null, strip = null, force = false, calibration = false, imageDir = defaultImageDir(), windowMs = SCAN_DUPLICATE_WINDOW_MS } = opts;
  const now = opts.now ?? Date.now();
  const failed = !result?.printing || result.status === "failed";
  if (failed && !(calibration && result)) return { scan: null, duplicate: false };
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

  if (!force && !failed) {
    const last = db.prepare("SELECT * FROM scans WHERE status = 'staged' ORDER BY updated_at DESC, id DESC LIMIT 1").get();
    const recent = last && now - Date.parse(last.updated_at) < windowMs;
    const same = result.status === "review"
      ? last?.match_status === "review" && last.printing_id === result.printing.id
      : last?.store_printing_id === store.id && last?.finish === finish;
    if (recent && same) return { scan: scanRow(last), duplicate: true };
  }

  const features = {
    ...(result.features || {}),
    result: {
      status: failed ? "failed" : result.status, printing_id: result.printing?.id ?? null, store_printing_id: store?.id ?? null, finish,
      finish_source: result.finishSource ?? null, method: result.method ?? null, confidence: result.confidence ?? null,
      claude_used: Boolean(result.claude_used), timings: result.timings ?? null,
    },
  };
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
      if (image) { imagePath = `scan-${id}.jpg`; writeFileSync(path.join(imageDir, imagePath), image); }
      // The strip is the user's own collector line: the printing picker shows it
      // zoomed in, and calibration re-runs OCR on it.
      if (strip) { stripPath = `scan-${id}-strip.jpg`; writeFileSync(path.join(imageDir, stripPath), strip); }
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
 */
export function updateScan(db, id, patch = {}, { idx, index = indexModule } = {}) {
  const row = requireStaged(db, id);
  const set = {};
  if (patch.printing_id != null || patch.store_lang != null) {
    if (!idx) throw new ScanError(503, "The card index is not available");
    const storeLang = patch.store_lang != null ? String(patch.store_lang).toLowerCase() : row.store_lang || "en";
    if (!/^[a-z]{2,3}$/.test(storeLang)) throw new ScanError(400, "store_lang must be a language code");
    const printing = index.getPrinting(idx, patch.printing_id != null ? String(patch.printing_id) : row.printing_id);
    if (!printing) throw new ScanError(400, "Unknown printing");
    const store = index.storagePrinting(idx, printing, storeLang) || printing;
    Object.assign(set, printingColumns(printing, store));
    set.store_lang = store.lang;
    if (patch.printing_id != null) set.match_status = "confirmed";
    // Keep the finish if the new printing has it; else its only finish / normal.
    const fins = finishesOf(store);
    if (patch.finish == null && !fins.includes(row.finish)) set.finish = fins.includes("normal") ? "normal" : fins[0];
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

/** +1 copy of a staged scan (the "scan again" / duplicate path). */
export function incrementScan(db, id) {
  const row = requireStaged(db, id);
  db.prepare("UPDATE scans SET quantity = MIN(999, quantity + 1), last_action = 'increment', undo = NULL, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  return getScan(db, row.id);
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
    return { undone: "decrement", scan: getScan(db, last.id) };
  }
  db.prepare("DELETE FROM scans WHERE id = ?").run(last.id);
  removeFiles(last, imageDir);
  return { undone: "delete", scan: scanRow(last) };
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
// index has no colours, legalities or prices: colours are approximated from
// the mana cost, and the row is marked (FALLBACK_FETCHED_AT) so the next
// successful commit replaces it with Scryfall's data.
function cardRowFromIndex(p) {
  const colors = "WUBRG".split("").filter((c) => String(p.mana_cost || "").includes(c)).join("");
  return {
    scryfall_id: p.id, oracle_id: p.oracle_id || p.id, name: p.name, set_code: p.set_code, set_name: p.set_name ?? null,
    collector_number: p.collector_number, lang: p.lang, rarity: p.rarity ?? null, type_line: p.type_line ?? null,
    mana_cost: p.mana_cost ?? null, cmc: null, colors, color_identity: colors, oracle_text: null, keywords: "[]",
    legalities: "{}", prices: "{}", image_small: p.image_small ?? p.faces?.[0]?.image_small ?? null,
    image_normal: p.image_normal ?? p.faces?.[0]?.image_normal ?? null, scryfall_uri: null, fetched_at: FALLBACK_FETCHED_AT,
  };
}

function validateTarget(db, target) {
  if (!target || typeof target !== "object") throw new ScanError(400, "target is required");
  if (target.type === "binder") {
    const name = typeof target.name === "string" ? target.name.trim() : "";
    if (!name) throw new ScanError(400, "target.name (binder) is required");
    if (name.length > 100) throw new ScanError(400, "Binder name is too long (max 100)");
    const exists = Boolean(db.prepare("SELECT 1 FROM collection WHERE binder = ? LIMIT 1").get(name));
    if (!exists && !target.create) throw new ScanError(404, `Binder "${name}" not found (set create to make it)`);
    return { type: "binder", name, created: !exists };
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
    const binder = t.type === "binder" ? t.name : t.owned ? t.name : null;
    if (binder != null) {
      for (const r of rows) insert.run(r.store_printing_id, r.finish, r.store_lang || "en", r.condition, binder, r.quantity);
    }
    if (t.type === "deck") {
      const deckRows = rows.map((r) => ({
        board: t.board, name: nameOf.get(r.store_printing_id)?.name ?? r.name, scryfall_id: r.store_printing_id, quantity: r.quantity,
      }));
      deckId = saveDeckRows(db, { id: deckId ?? undefined, name: t.name, format: t.format ?? null, source: "scan", rows: deckRows, append: true });
    }
    const to = JSON.stringify(t.type === "deck" ? { type: "deck", id: deckId, name: t.name, board: t.board } : { type: "binder", name: t.name });
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
    ? { type: "deck", id: result.deckId, name: t.name, board: t.board, created: t.created, binder: t.owned ? t.name : null }
    : { type: "binder", name: t.name, created: t.created };
  return { committed: rows.length, copies, target: outTarget };
}

// ---------------------------------------------------------------------------
// Binders (collection.binder; '' is "no binder")

/** [{name, cards (printings), copies, sources: ['manabox','scan']}] */
export function listBinders(db) {
  return db.prepare(
    `SELECT binder AS name, COUNT(DISTINCT scryfall_id) AS cards, SUM(quantity) AS copies, GROUP_CONCAT(DISTINCT source) AS sources
       FROM collection GROUP BY binder ORDER BY binder = '', binder COLLATE NOCASE`,
  ).all().map((r) => ({ ...r, sources: String(r.sources || "").split(",").filter(Boolean).sort() }));
}

/**
 * Rename a binder (merging into an existing one of the new name). Binders
 * with ManaBox rows are refused: the next replace import would put those rows
 * back under the old name. A scan-created deck of the same name follows.
 */
export function renameBinder(db, from, to) {
  const name = typeof to === "string" ? to.trim() : "";
  if (!name) throw new ScanError(400, "name is required");
  if (name.length > 100) throw new ScanError(400, "Binder name is too long (max 100)");
  if (!db.prepare("SELECT 1 FROM collection WHERE binder = ? LIMIT 1").get(from)) throw new ScanError(404, "Binder not found");
  if (name === from) return { renamed: 0, name };
  if (db.prepare("SELECT 1 FROM collection WHERE binder = ? AND source = 'manabox' LIMIT 1").get(from)) {
    throw new ScanError(409, `Binder "${from}" holds cards imported from ManaBox; rename it in ManaBox (the next import brings the new name)`);
  }
  return transaction(db, () => {
    const deck = db.prepare("SELECT id FROM decks WHERE name = ? AND source = 'scan'").get(from);
    if (deck && !db.prepare("SELECT 1 FROM decks WHERE name = ? COLLATE NOCASE").get(name)) {
      db.prepare("UPDATE decks SET name = ? WHERE id = ?").run(name, deck.id);
    }
    const moved = db.prepare(
      `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
       SELECT scryfall_id, finish, language, condition, ?, quantity, purchase_price, purchase_currency, source FROM collection WHERE binder = ?
       ON CONFLICT (scryfall_id, finish, language, condition, binder, source) DO UPDATE SET quantity = quantity + excluded.quantity`,
    ).run(name, from).changes;
    db.prepare("DELETE FROM collection WHERE binder = ?").run(from);
    return { renamed: moved, name };
  });
}

/** Delete a binder's rows of one source (the API only allows 'scan'). */
export function deleteBinder(db, name, { source = "scan" } = {}) {
  const info = db.prepare("DELETE FROM collection WHERE binder = ? AND source = ?").run(name, source);
  return { deleted: info.changes };
}

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
