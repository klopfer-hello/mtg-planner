// Committing staged scans to a binder (collection rows, source 'scan') or a
// deck: card data for the stored printings from Scryfall /cards/collection
// (2 req/s), the local card index as the offline fallback, and the label each
// committed row keeps (its final printing + finish are the truth).

import { transaction, upsertCards } from "./db.js";
import { BOARDS } from "./deckrules.js";
import { saveDeckRows } from "./decks.js";
import { recordDeckVersion } from "./deckhistory.js";
import { ensureBinder, findBinder } from "./binders.js";
import { normalizeCard, scryfall } from "./scryfall.js";
import { defaultImageDir, getRow, isPlain, nowIso, parse, removeFiles, ScanError } from "./scanrow.js";
import { isCalibrationTruth, labelOf, REFRESHED_SOURCES, userSource } from "./scanlabels.js";
import * as indexModule from "./cardindex.js";

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

// Calibration scans keep their photos after a commit; confirmation labels don't need them.
const keepsImages = (r) => Boolean(r.calibration) || isCalibrationTruth(parse(r.calibration_truth, null));

// The label a committed row keeps: its final printing + finish are the truth (a
// calibration truth stays as recorded). A detected row nobody touched gets source 'commit';
// a final printing other than the detected one is a correction. Manual rows were never detected.
function commitLabel(r, at) {
  const truth = parse(r.calibration_truth, null);
  if (isCalibrationTruth(truth) || r.match_status === "manual" || !r.printing_id) return r.calibration_truth ?? null;
  const src = isPlain(truth) && REFRESHED_SOURCES.has(truth.source) ? truth.source : "commit";
  const source = userSource(r, r.printing_id) === "correction" ? "correction" : src;
  return JSON.stringify({ ...labelOf(r, source, isPlain(truth) ? truth.recorded_at ?? at : at), committed_at: at });
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
  let committed = rows;
  const result = transaction(db, () => {
    upsertCards(db, cardRows);
    // The Scryfall await above lets +1 / PATCH / DELETE / undo (not under exclusive()) run in
    // between: commit what the rows say NOW, and refuse when one can't be committed any more.
    committed = rows.map((r) => {
      const f = getRow(db, r.id);
      if (!f || f.status !== "staged") throw new ScanError(409, `Scan ${r.id} was removed or committed meanwhile; reload and try again`);
      if (f.match_status === "review" || !f.store_printing_id) throw new ScanError(409, `Scan ${r.id} (${f.name}) changed meanwhile and needs review; reload and try again`);
      if (!check.get(f.store_printing_id)) throw new ScanError(409, `Scan ${r.id} (${f.name}) changed its printing meanwhile; commit again`);
      return f;
    });
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
      for (const r of committed) insert.run(r.store_printing_id, r.finish, r.store_lang || "en", r.condition, binder, r.quantity);
    }
    if (t.type === "deck") {
      const deckRows = committed.map((r) => ({
        board: t.board, name: nameOf.get(r.store_printing_id)?.name ?? r.name, scryfall_id: r.store_printing_id, quantity: r.quantity,
      }));
      deckId = saveDeckRows(db, { id: deckId ?? undefined, name: t.name, format: t.format ?? null, source: "scan", rows: deckRows, append: true });
      recordDeckVersion(db, deckId, { actor: "scan" });
    }
    // A deck commit records whether owned copies were added and where (lib/edits.js relanguageScans).
    const to = JSON.stringify(t.type === "deck"
      ? { type: "deck", id: deckId, name: t.name, board: t.board, owned: Boolean(t.owned), binder }
      : { type: "binder", name: t.name });
    const mark = db.prepare(`UPDATE scans SET status = 'committed', committed_at = ?, committed_to = ?, image_path = ?, strip_path = ?,
      calibration_truth = ? WHERE id = ?`);
    for (const r of committed) {
      const keep = keepsImages(r);
      mark.run(committedAt, to, keep ? r.image_path : null, keep ? r.strip_path : null, commitLabel(r, committedAt), r.id);
    }
    return { deckId };
  });
  // Images of committed scans are only kept for calibration.
  for (const r of committed) if (!keepsImages(r)) removeFiles(r, imageDir);

  const copies = committed.reduce((a, r) => a + r.quantity, 0);
  const outTarget = t.type === "deck"
    ? { type: "deck", id: result.deckId, name: t.name, board: t.board, created: t.created, binder: t.owned ? (findBinder(db, t.name) ?? t.name) : null }
    : { type: "binder", name: t.name, created: t.created };
  return { committed: committed.length, copies, target: outTarget };
}
