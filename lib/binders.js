// Binders: named storage groups of owned copies.
//
// A copy's binder is collection.binder ('' = "Unsorted"). The `binders` table
// (migration v4) only exists so a binder can be created before it holds a card;
// the list the app shows is that table united with every binder name in use.
// Names compare case-insensitively everywhere ("Trade" == "trade").
//
// Who is the master of the collection? By default ManaBox: a "replace" import
// rebuilds every ManaBox-sourced row. Once the user organises ManaBox cards in
// the app (moves or renames them), mtg-planner becomes the master: the moved
// copies turn into source 'app' rows (a replace import never touches them), the
// meta key collection_master flips to 'app', and imports then default to "delta"
// (only copies ManaBox gained since its last export are added, lib/manabox.js).
// That flip needs the caller's explicit confirmation once (confirm_master).
//
// Every binder has a type (binder | deck_box | bulk | trade | other) for the
// overview's grouping. Unless the user picked one (binders.type, migration
// v14) it is derived on every read: deck-box names and binders linked to a deck
// are deck boxes, the rest plain binders. Very large binders are only
// *suggested* as bulk (type_suggest), never switched on their own.

import { cardPrice, getAppMeta, setAppMeta, transaction } from "./db.js";
import { copyList, deleteMoves, tracker, writeLog } from "./editlog.js";
import { CLAIM_BOARDS, allocation, cardKey, deckDetail } from "./decks.js";
import { BINDER_TYPES, DECK_BOX_PREFIX, autoBinderType, boxSuggestion, deckBoxes, deckLinks } from "./deckboxes.js";

export const MAX_BINDER_NAME = 100;
export const MASTER_KEY = "collection_master";
export const MASTERS = ["manabox", "app"];

/** Error with an HTTP status (and optional extra JSON fields) for the API layer. */
export class BinderError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** 'manabox' (default) or 'app'. */
export function collectionMaster(db) {
  return getAppMeta(db, MASTER_KEY) === "app" ? "app" : "manabox";
}

export function setCollectionMaster(db, value) {
  if (!MASTERS.includes(value)) throw new BinderError(400, `collection_master must be ${MASTERS.join(" or ")}`);
  setAppMeta(db, MASTER_KEY, value);
  return value;
}

/** ManaBox import mode when the caller doesn't pick one: delta once the app is the master. */
export const defaultImportMode = (db) => (collectionMaster(db) === "app" ? "delta" : "replace");

function cleanName(v, field = "name") {
  if (typeof v !== "string") throw new BinderError(400, `${field} is required`);
  const s = v.trim();
  if (!s) throw new BinderError(400, `${field} is required`);
  if (s.length > MAX_BINDER_NAME) throw new BinderError(400, `Binder name is too long (max ${MAX_BINDER_NAME})`);
  return s;
}

/** Stored spelling of a binder (table first, then collection), or null. '' is never a binder. */
export function findBinder(db, name) {
  if (typeof name !== "string" || !name.trim()) return null;
  return db.prepare("SELECT name FROM binders WHERE name = ?").get(name)?.name
    ?? db.prepare("SELECT binder FROM collection WHERE binder = ? COLLATE NOCASE AND binder <> '' ORDER BY id LIMIT 1").get(name)?.binder
    ?? null;
}

/** Register a binder name. origin 'app' wins over 'manabox' (app binders survive replace imports). */
export function ensureBinder(db, name, origin = "app", createdAt = null) {
  if (!name) return;
  db.prepare(
    `INSERT INTO binders (name, origin, created_at) VALUES (?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(name) DO UPDATE SET origin = CASE WHEN excluded.origin = 'app' THEN 'app' ELSE origin END`,
  ).run(name, origin, createdAt);
}

/** Drop empty ManaBox-only binders (after a replace import removed their cards). */
export function pruneManaboxBinders(db) {
  return db.prepare(
    `DELETE FROM binders WHERE origin = 'manabox'
       AND NOT EXISTS (SELECT 1 FROM collection WHERE collection.binder = binders.name COLLATE NOCASE)`,
  ).run().changes;
}

const emptyCounts = () => ({ cards: 0, unique_cards: 0, copies: 0, sources: [], by_source: {} });

export { BINDER_TYPES, autoBinderType };
/** Copies above which an untyped binder is suggested as bulk (the UI asks once). */
export const BULK_SUGGEST_COPIES = 1000;

/**
 * Per binder (lower name): EUR value (cardPrice of each copy's finish, EUR only, like
 * stats()), the most valuable card (top) and the printings it holds. One collection pass.
 */
function binderValues(db) {
  const out = new Map();
  const rows = db.prepare(
    `SELECT lower(col.binder) AS k, col.finish, col.quantity, c.scryfall_id, c.name, c.prices, c.image_small, c.image_normal
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id`,
  ).all();
  for (const r of rows) {
    let e = out.get(r.k);
    if (!e) out.set(r.k, (e = { value: 0, top: null, ids: new Set() }));
    e.ids.add(r.scryfall_id);
    const p = cardPrice(r, r.finish);
    if (!p || p.currency !== "€") continue;
    e.value += p.value * r.quantity;
    if (!e.top || p.value > e.top.price_eur) {
      e.top = { scryfall_id: r.scryfall_id, name: r.name, price_eur: p.value, image_small: r.image_small, image_normal: r.image_normal };
    }
  }
  return out;
}

const coverOf = (c, chosen) => (c ? {
  scryfall_id: c.scryfall_id, name: c.name, image: c.image_normal || c.image_small || null,
  image_small: c.image_small || c.image_normal || null, chosen,
} : null);

/**
 * {binders: [{name, cards (printings), unique_cards (oracle cards), copies, sources,
 * by_source: {manabox|scan|app: {cards, copies}}, created_at, empty, type, type_auto, type_set,
 * type_suggest ('bulk'|null), value_eur, top {scryfall_id, name, price_eur, image_small,
 * image_normal}|null, cover {scryfall_id, name, image, image_small, chosen}|null,
 * decks [{id, name, status}]}], unsorted: {...counts, value_eur, top, cover}, collection_master}.
 * `unsorted` is the '' bucket (copies without a binder). A chosen cover counts only while
 * the binder still holds that printing (else the most valuable card).
 */
export function listBinders(db) {
  const totals = db.prepare(
    `SELECT lower(col.binder) AS k, MIN(col.binder) AS name, COUNT(DISTINCT col.scryfall_id) AS cards,
            COUNT(DISTINCT COALESCE(c.oracle_id, col.scryfall_id)) AS unique_cards, SUM(col.quantity) AS copies
       FROM collection col LEFT JOIN cards c ON c.scryfall_id = col.scryfall_id
      GROUP BY lower(col.binder)`,
  ).all();
  const perSource = db.prepare(
    `SELECT lower(binder) AS k, source, COUNT(DISTINCT scryfall_id) AS cards, SUM(quantity) AS copies
       FROM collection GROUP BY lower(binder), source ORDER BY source`,
  ).all();
  const table = new Map(db.prepare("SELECT name, created_at, type, cover_scryfall_id FROM binders").all().map((r) => [r.name.toLowerCase(), r]));
  const byKey = new Map();
  for (const t of totals) {
    byKey.set(t.k, { name: table.get(t.k)?.name ?? t.name, cards: t.cards, unique_cards: t.unique_cards, copies: t.copies, sources: [], by_source: {} });
  }
  for (const s of perSource) {
    const e = byKey.get(s.k);
    e.sources.push(s.source);
    e.by_source[s.source] = { cards: s.cards, copies: s.copies };
  }
  for (const [k, t] of table) if (!byKey.has(k)) byKey.set(k, { name: t.name, ...emptyCounts() });
  const values = binderValues(db);
  const links = deckLinks(db);
  const boxes = deckBoxes(db);
  const allDecks = db.prepare("SELECT id, name, status, box_binder FROM decks ORDER BY id").all();
  // Decks that already have a box (own a deck box, or are linked to an existing binder) get no suggestion.
  const boxedDecks = new Set([...boxes.values()].flatMap((b) => b.owners.map((o) => o.id)));
  for (const d of allDecks) if (d.box_binder && (table.has(d.box_binder.toLowerCase()) || byKey.has(d.box_binder.toLowerCase()))) boxedDecks.add(Number(d.id));
  const cardStmt = db.prepare("SELECT scryfall_id, name, image_small, image_normal FROM cards WHERE scryfall_id = ?");
  const money = (v) => Math.round((v ?? 0) * 100) / 100;
  const valued = (k, e, coverId = null) => {
    const v = values.get(k);
    const chosen = coverId && v?.ids.has(coverId) ? cardStmt.get(coverId) : null;
    return { ...e, value_eur: money(v?.value), top: v?.top ?? null, cover: chosen ? coverOf(chosen, true) : coverOf(v?.top, false) };
  };
  const unsorted = valued("", byKey.get("") ?? { name: "", ...emptyCounts() });
  byKey.delete("");
  const binders = [...byKey.entries()].map(([k, e]) => {
    const t = table.get(k);
    const decks = links.get(k) ?? [];
    const typeAuto = autoBinderType(e.name, decks.length > 0);
    const typeSet = BINDER_TYPES.includes(t?.type);
    return {
      ...valued(k, e, t?.cover_scryfall_id),
      created_at: t?.created_at ?? null, empty: e.copies === 0,
      type: typeSet ? t.type : typeAuto, type_auto: typeAuto, type_set: typeSet,
      type_suggest: !typeSet && typeAuto === "binder" && e.copies > BULK_SUGGEST_COPIES ? "bulk" : null,
      decks,
      ...boxFields(e.name, boxes.get(k), allDecks, boxedDecks),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { binders, unsorted, collection_master: collectionMaster(db) };
}

/**
 * Deck-box fields of a listed binder: reserved (effective type deck_box: its copies are
 * reserved for the box, lib/decks.js allocation), box_deck {id, name, status, via
 * link|manabox|name} (the deck that owns it, null = nobody's) and deck_suggest {id, name,
 * status, similarity} (an unowned box whose name closely matches a deck without a box).
 */
function boxFields(name, box, decks, boxedDecks) {
  if (!box) return { reserved: false, box_deck: null, deck_suggest: null };
  return {
    reserved: true, box_deck: box.owners[0] ?? null,
    deck_suggest: box.owners.length ? null : boxSuggestion(name, decks, boxedDecks),
  };
}

/**
 * Set a binder's type and/or cover. type: one of BINDER_TYPES, or null / 'auto' (back to
 * the auto rule); cover_scryfall_id: a printing the binder holds, or null (most valuable
 * card). A key left undefined stays. Returns {name, ...listBinders}.
 */
export function setBinderProps(db, name, { type, cover_scryfall_id: cover, deck_id: deckId } = {}) {
  const stored = requireBinder(db, name);
  if (deckId !== undefined && deckId !== null) {
    if (!Number.isInteger(deckId) || deckId < 1) throw new BinderError(400, "deck_id must be a deck id or null");
    if (!db.prepare("SELECT 1 FROM decks WHERE id = ?").get(deckId)) throw new BinderError(404, "Deck not found");
  }
  if (type !== undefined && type !== null && type !== "auto" && !BINDER_TYPES.includes(type)) {
    throw new BinderError(400, `type must be one of ${BINDER_TYPES.join(", ")} (or null for auto)`);
  }
  if (cover !== undefined && cover !== null) {
    if (typeof cover !== "string" || !cover) throw new BinderError(400, "cover_scryfall_id must be a string or null");
    if (!db.prepare("SELECT 1 FROM collection WHERE binder = ? COLLATE NOCASE AND scryfall_id = ? LIMIT 1").get(stored, cover)) {
      throw new BinderError(400, "The cover card must be a printing in this binder");
    }
  }
  if (type === undefined && cover === undefined && deckId === undefined) {
    throw new BinderError(400, "Nothing to change (name, type, cover_scryfall_id or deck_id)");
  }
  transaction(db, () => {
    // A binder known only from its rows gets its table entry (never upgrades the origin).
    ensureBinder(db, stored, "manabox");
    if (type !== undefined) db.prepare("UPDATE binders SET type = ? WHERE name = ?").run(type === "auto" ? null : type, stored);
    if (cover !== undefined) db.prepare("UPDATE binders SET cover_scryfall_id = ? WHERE name = ?").run(cover, stored);
    // The box link (decks.box_binder): one box per deck, one deck per box.
    if (deckId !== undefined) {
      db.prepare("UPDATE decks SET box_binder = NULL WHERE box_binder = ? COLLATE NOCASE AND id IS NOT ?").run(stored, deckId);
      if (deckId !== null) db.prepare("UPDATE decks SET box_binder = ? WHERE id = ?").run(stored, deckId);
    }
  });
  return { name: db.prepare("SELECT name FROM binders WHERE name = ?").get(stored)?.name ?? stored, ...listBinders(db) };
}

/** Create an empty binder. Returns {name, created_at}. */
export function createBinder(db, name) {
  const n = cleanName(name);
  const existing = findBinder(db, n);
  if (existing) throw new BinderError(409, `Binder "${existing}" already exists`);
  ensureBinder(db, n, "app");
  return db.prepare("SELECT name, created_at FROM binders WHERE name = ?").get(n);
}

// ---------------------------------------------------------------------------
// Moving copies

const UPSERT = `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (scryfall_id, finish, language, condition, binder, source)
  DO UPDATE SET quantity = quantity + excluded.quantity,
                purchase_price = COALESCE(purchase_price, excluded.purchase_price),
                purchase_currency = COALESCE(purchase_currency, excluded.purchase_currency)`;

/**
 * Move `n` copies of each collection row to binder `to`, in the current
 * transaction. ManaBox rows land as source 'app'. Returns {moved, converted}.
 * allocations: [{row, n}] (row = full collection row).
 */
function applyMoves(db, allocations, to, { keepSource = true } = {}) {
  const upsert = db.prepare(UPSERT);
  const del = db.prepare("DELETE FROM collection WHERE id = ?");
  const dec = db.prepare("UPDATE collection SET quantity = quantity - ? WHERE id = ?");
  const current = db.prepare("SELECT quantity FROM collection WHERE id = ?");
  let moved = 0, converted = 0;
  for (const { row: loaded, n: wanted } of allocations) {
    // Re-read the quantity: an earlier move in this batch may have merged copies into this
    // row (a binder with rows under two spellings, "Trade" and "trade").
    const q = current.get(loaded.id)?.quantity ?? 0;
    const row = { ...loaded, quantity: q };
    const n = Math.min(wanted, q);
    if (n <= 0) continue;
    const source = row.source === "manabox" ? "app" : row.source;
    // An emptied binder stays (as an empty binder) even if it only existed through its rows.
    if (keepSource && row.binder) ensureBinder(db, row.binder, row.source === "manabox" ? "manabox" : "app");
    // Remove first: the destination may be the same printing in another case of the binder name.
    if (n >= row.quantity) del.run(row.id); else dec.run(n, row.id);
    upsert.run(row.scryfall_id, row.finish, row.language, row.condition, to, n, row.purchase_price, row.purchase_currency, source);
    moved += n;
    if (row.source === "manabox") converted += n;
  }
  return { moved, converted };
}

/** Throws 409 {code:'confirm_master'} when ManaBox copies would move before the user agreed. */
export function checkMaster(db, manaboxCopies, confirmMaster) {
  if (manaboxCopies > 0 && collectionMaster(db) !== "app" && !confirmMaster) {
    throw new BinderError(409,
      `This changes ${manaboxCopies} ${manaboxCopies === 1 ? "copy" : "copies"} imported from ManaBox. From now on mtg-planner is the master ` +
      "of your collection: the moved copies are kept by the app, and ManaBox imports add cards instead of replacing the collection. " +
      "Send confirm_master to proceed.",
      { code: "confirm_master", manabox_copies: manaboxCopies });
  }
}

const SOURCE_ORDER = { app: 0, scan: 1, manabox: 2 };
export const bySourceOrder = (a, b) => (SOURCE_ORDER[a.source] ?? 3) - (SOURCE_ORDER[b.source] ?? 3) || a.id - b.id;
const sameBinder = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Resolve the target binder name: '' (Unsorted), an existing binder's spelling, or a new name with create. */
function resolveTarget(db, toBinder, create) {
  if (typeof toBinder !== "string") throw new BinderError(400, 'to_binder is required ("" = Unsorted)');
  if (!toBinder.trim()) return { name: "", created: false };
  const n = cleanName(toBinder, "to_binder");
  const existing = findBinder(db, n);
  if (existing) return { name: existing, created: false };
  if (!create) throw new BinderError(404, `Binder "${n}" not found (set create to make it)`);
  return { name: n, created: true };
}

/**
 * Resolve API row items to the copies they name, without changing anything.
 * items: [{scryfall_id, finish?, language?, condition?, binder? (default ''), source?, quantity (default 1)}]
 *      | [{oracle_id, from_binder?}] | [{printing_id, from_binder?}] (every copy).
 * A row key's copies are taken app -> scan -> manabox unless `source` is given.
 * Returns Map(row id -> {row, n}); throws BinderError 400/404/409. Shared by
 * moveCopies and lib/edits.js (edit / delete).
 */
export function selectCopies(db, items, { verb = "move" } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new BinderError(400, "items must be a non-empty array");
  if (items.length > 1000) throw new BinderError(400, `At most 1000 items per ${verb}`);

  const rowsOfKey = db.prepare(
    `SELECT * FROM collection WHERE scryfall_id = ? AND finish = ? AND language = ? AND condition = ? AND binder = ? COLLATE NOCASE`,
  );
  const rowsOfCard = db.prepare(
    `SELECT col.* FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE c.oracle_id = ?`,
  );
  const rowsOfPrinting = db.prepare("SELECT * FROM collection WHERE scryfall_id = ?");
  const alloc = new Map(); // row id -> {row, n}
  const take = (row, n) => {
    const cur = alloc.get(row.id) ?? { row, n: 0 };
    cur.n = Math.min(row.quantity, cur.n + n);
    alloc.set(row.id, cur);
  };
  let matched = 0;
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== "object") throw new BinderError(400, `items[${i}] must be an object`);
    if (it.oracle_id != null) {
      if (typeof it.oracle_id !== "string" || !it.oracle_id) throw new BinderError(400, `items[${i}].oracle_id must be a string`);
      if (it.from_binder != null && typeof it.from_binder !== "string") throw new BinderError(400, `items[${i}].from_binder must be a string`);
      const from = it.from_binder == null ? null : it.from_binder.trim();
      const rows = rowsOfCard.all(it.oracle_id).filter((r) => from == null || sameBinder(r.binder, from));
      matched += rows.length;
      for (const r of rows) take(r, r.quantity);
      continue;
    }
    if (it.printing_id != null) {
      if (typeof it.printing_id !== "string" || !it.printing_id) throw new BinderError(400, `items[${i}].printing_id must be a string`);
      if (it.from_binder != null && typeof it.from_binder !== "string") throw new BinderError(400, `items[${i}].from_binder must be a string`);
      const from = it.from_binder == null ? null : it.from_binder.trim();
      const rows = rowsOfPrinting.all(it.printing_id).filter((r) => from == null || sameBinder(r.binder, from));
      matched += rows.length;
      for (const r of rows) take(r, r.quantity);
      continue;
    }
    if (typeof it.scryfall_id !== "string" || !it.scryfall_id) throw new BinderError(400, `items[${i}] needs scryfall_id, printing_id or oracle_id`);
    const qty = it.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1) throw new BinderError(400, `items[${i}].quantity must be a positive integer`);
    const str = (v, d, f) => {
      if (v == null) return d;
      if (typeof v !== "string") throw new BinderError(400, `items[${i}].${f} must be a string`);
      return v;
    };
    const key = [it.scryfall_id, str(it.finish, "normal", "finish"), str(it.language, "en", "language"),
      str(it.condition, "near_mint", "condition"), str(it.binder, "", "binder")];
    const source = str(it.source, null, "source");
    const rows = rowsOfKey.all(...key).filter((r) => !source || r.source === source).sort(bySourceOrder);
    const available = rows.reduce((a, r) => a + r.quantity - (alloc.get(r.id)?.n ?? 0), 0);
    if (!rows.length) throw new BinderError(404, `items[${i}]: no such copies in the collection`);
    if (available < qty) throw new BinderError(409, `items[${i}]: only ${available} ${available === 1 ? "copy" : "copies"} available`);
    matched += rows.length;
    let left = qty;
    for (const r of rows) {
      const free = r.quantity - (alloc.get(r.id)?.n ?? 0);
      const n = Math.min(free, left);
      if (n > 0) { take(r, n); left -= n; }
      if (!left) break;
    }
  }
  if (!matched) throw new BinderError(404, "None of these cards are in the collection");
  return alloc;
}

/**
 * Move copies between binders (one transaction).
 * items: [{scryfall_id, finish?, language?, condition?, binder? (from, default ''), source?, quantity}]
 *      | [{oracle_id, from_binder?}] (every copy of the card, optionally only from one binder)
 *      | [{printing_id, from_binder?}] (every copy of one printing).
 * Copies already in the target binder stay. Returns {moved_copies, converted_copies,
 * to_binder, created, collection_master, ...listBinders}.
 */
export function moveCopies(db, { items, to_binder, create = false, confirm_master = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new BinderError(400, "items must be a non-empty array");
  if (items.length > 1000) throw new BinderError(400, "At most 1000 items per move");
  const target = resolveTarget(db, to_binder, Boolean(create));
  const alloc = selectCopies(db, items, { verb: "move" });

  // Copies already in the target binder stay where they are.
  const allocations = [...alloc.values()].filter((a) => !sameBinder(a.row.binder, target.name));
  const manabox = allocations.filter((a) => a.row.source === "manabox").reduce((s, a) => s + a.n, 0);
  checkMaster(db, manabox, confirm_master);

  const res = transaction(db, () => {
    if (target.name) ensureBinder(db, target.name, "app");
    const r = applyMoves(db, allocations, target.name);
    if (r.converted) setAppMeta(db, MASTER_KEY, "app");
    return r;
  });
  return { moved_copies: res.moved, converted_copies: res.converted, to_binder: target.name, created: target.created, ...listBinders(db) };
}

// ---------------------------------------------------------------------------
// Rename / delete

function binderRows(db, name) {
  return db.prepare("SELECT * FROM collection WHERE binder = ? COLLATE NOCASE ORDER BY id").all(name);
}

function requireBinder(db, name) {
  const stored = findBinder(db, name);
  if (!stored) throw new BinderError(404, "Binder not found");
  return stored;
}

/**
 * Rename a binder, merging into an existing binder of the new name (quantities
 * add up on the unique key). Every source moves; ManaBox rows become 'app'
 * (confirm_master needed the first time). A scan-created deck of the same name follows.
 */
export function renameBinder(db, from, to, { confirm_master = false } = {}) {
  const name = cleanName(to);
  const stored = requireBinder(db, from);
  if (name === stored) return { renamed: 0, name, merged: false, converted_copies: 0, ...listBinders(db) };
  const existing = findBinder(db, name);
  const caseOnly = sameBinder(name, stored);
  const target = existing && !caseOnly ? existing : name;
  const rows = binderRows(db, stored);
  const manabox = rows.filter((r) => r.source === "manabox").reduce((s, r) => s + r.quantity, 0);
  checkMaster(db, manabox, confirm_master);

  return transaction(db, () => {
    const deck = db.prepare("SELECT id FROM decks WHERE name = ? AND source = 'scan'").get(stored);
    if (deck && !db.prepare("SELECT 1 FROM decks WHERE name = ? COLLATE NOCASE AND id <> ?").get(target, deck.id)) {
      db.prepare("UPDATE decks SET name = ? WHERE id = ?").run(target, deck.id);
    }
    const old = db.prepare("SELECT created_at, type, cover_scryfall_id FROM binders WHERE name = ?").get(stored);
    db.prepare("DELETE FROM binders WHERE name = ?").run(stored);
    db.prepare("UPDATE decks SET box_binder = ? WHERE box_binder = ? COLLATE NOCASE").run(target, stored);
    ensureBinder(db, target, "app", existing && !caseOnly ? null : old?.created_at ?? null);
    // Type and cover follow the rename; a merge keeps the target's own choice.
    db.prepare("UPDATE binders SET type = COALESCE(type, ?), cover_scryfall_id = COALESCE(cover_scryfall_id, ?) WHERE name = ?")
      .run(old?.type ?? null, old?.cover_scryfall_id ?? null, target);
    const r = applyMoves(db, rows.map((row) => ({ row, n: row.quantity })), target, { keepSource: false });
    if (r.converted) setAppMeta(db, MASTER_KEY, "app");
    return { renamed: r.moved, name: target, merged: Boolean(existing && !caseOnly), converted_copies: r.converted, ...listBinders(db) };
  });
}

/**
 * Delete a binder.
 * cards 'unsort' (default): its copies move to Unsorted ('' binder; ManaBox rows become 'app').
 * cards 'delete': its copies are deleted, logged in the edit log (undoable, returns edit_id);
 *   ManaBox copies only when the app is the master (409 manabox_rows otherwise; confirm_master
 *   flips the master to the app and deletes).
 * The legacy `source` option (delete only the scanned rows, unlogged) was removed in v0.5.0:
 * every collection delete needs an explicit confirmation and is logged; it answers 400.
 */
export function deleteBinder(db, name, { cards = "unsort", source = null, confirm_master = false, actor = "app" } = {}) {
  if (source != null) {
    throw new BinderError(400, "Deleting a binder's rows by source is no longer supported; use cards=delete (logged, undoable)");
  }
  if (cards !== "unsort" && cards !== "delete") throw new BinderError(400, 'cards must be "unsort" or "delete"');
  const stored = requireBinder(db, name);
  const rows = binderRows(db, stored);
  const manabox = rows.filter((r) => r.source === "manabox").reduce((s, r) => s + r.quantity, 0);
  // Like POST /api/collection/delete: confirm_master flips the master to the app first
  // (deleting ManaBox copies means the app decides what is owned).
  if (cards === "delete" && manabox > 0 && collectionMaster(db) !== "app" && !confirm_master) {
    throw new BinderError(409,
      `Binder "${stored}" holds ${manabox} ${manabox === 1 ? "copy" : "copies"} imported from ManaBox. ` +
      "Move them to Unsorted instead, or delete them in ManaBox (the next replace import removes them).",
      { code: "manabox_rows", manabox_copies: manabox });
  }
  if (cards === "unsort") checkMaster(db, manabox, confirm_master);
  return transaction(db, () => {
    let deleted = 0, unsorted = 0, converted = 0;
    let editId = null;
    if (cards === "delete") {
      // Decks boxed in this binder: the log keeps their box_binder so an undo restores it.
      const decks = db.prepare("SELECT id, box_binder FROM decks WHERE box_binder = ? COLLATE NOCASE ORDER BY id").all(stored)
        .map((d) => ({ id: Number(d.id), box_binder: d.box_binder }));
      // Logged like POST /api/collection/delete, so the copies can be brought back (undo
      // restores the binder too).
      // Which ManaBox lines the copies came from, so a replace import does not load them again.
      const moves = deleteMoves(db, rows.map((row) => ({ row, n: row.quantity })));
      const t = tracker(db);
      const names = new Map();
      const nameOf = db.prepare("SELECT name FROM cards WHERE scryfall_id = ?");
      const del = db.prepare("DELETE FROM collection WHERE id = ?");
      for (const r of rows) {
        t.touch(r);
        del.run(r.id);
        deleted += r.quantity;
        const n = nameOf.get(r.scryfall_id)?.name ?? r.scryfall_id;
        names.set(n, (names.get(n) ?? 0) + r.quantity);
      }
      if (manabox > 0) setAppMeta(db, MASTER_KEY, "app");
      if (deleted) {
        editId = writeLog(db, {
          kind: "delete", actor, copies: deleted, rows: t.finish(), moves, decks,
          summary: `Deleted binder "${stored}" with ${deleted} ${deleted === 1 ? "copy" : "copies"}: ${copyList(names)}`,
        });
      }
    } else {
      const r = applyMoves(db, rows.map((row) => ({ row, n: row.quantity })), "", { keepSource: false });
      unsorted = r.moved;
      converted = r.converted;
      if (converted) setAppMeta(db, MASTER_KEY, "app");
    }
    db.prepare("DELETE FROM binders WHERE name = ?").run(stored);
    db.prepare("UPDATE decks SET box_binder = NULL WHERE box_binder = ? COLLATE NOCASE").run(stored);
    return { name: stored, deleted_copies: deleted, unsorted_copies: unsorted, converted_copies: converted, edit_id: editId, ...listBinders(db) };
  });
}

// ---------------------------------------------------------------------------
// Deck boxes

export { DECK_BOX_PREFIX };

/**
 * Where a deck's copies go and come from (deckToBinder, the build checklist in lib/deckbuild.js):
 * {target (the deck box binder: `binder`, else the remembered box, else "Deck box: <name>"),
 * protectedBinders: Map lower-cased binder -> name of the deck it holds, or null (never a source:
 * another BUILT deck's box, "Deck box: <name>", ManaBox binder or same-named binder, and every
 * deck box (lib/deckboxes.js) this deck doesn't own), reservedBoxes: Map lower-cased binder ->
 * {binder, deck|null} (those deck boxes), isOwn(row) (target or this deck's ManaBox binder: the
 * copies there ARE the deck), rank(row) (take order: previous box, Unsorted, plain binders,
 * "Deck box: …" binders the user retyped)}.
 */
export function deckBoxContext(db, deck, binder = null) {
  const name = binder?.trim() ? cleanName(binder, "binder")
    : deck.box_binder || `${DECK_BOX_PREFIX}${deck.name}`.slice(0, MAX_BINDER_NAME).trim();
  const target = findBinder(db, name) ?? name;
  const protectedBinders = new Map();
  for (const d of db.prepare("SELECT name, manabox_binder, box_binder FROM decks WHERE status = 'built' AND id <> ?").all(deck.id)) {
    const add = (b) => { if (b && !protectedBinders.has(b.toLowerCase())) protectedBinders.set(b.toLowerCase(), d.name); };
    add(d.box_binder);
    add(d.manabox_binder);
    add(`${DECK_BOX_PREFIX}${d.name}`.slice(0, MAX_BINDER_NAME).trim());
    add(d.name);
  }
  const own = new Set([target.toLowerCase()]);
  if (deck.source === "manabox") own.add((deck.manabox_binder || deck.name).toLowerCase());
  // Deck boxes of other decks (built or not) and boxes nobody owns: reserved, never a source.
  const reservedBoxes = new Map();
  for (const [k, b] of deckBoxes(db)) {
    if (own.has(k) || b.owners.some((o) => o.id === Number(deck.id))) continue;
    reservedBoxes.set(k, { binder: b.name, deck: b.owners[0]?.name ?? null });
    if (!protectedBinders.has(k)) protectedBinders.set(k, b.owners[0]?.name ?? null);
  }
  for (const b of own) protectedBinders.delete(b);
  const isOwn = (r) => own.has(r.binder.toLowerCase());
  // A previous box of this deck (target changed) empties first.
  const prevBox = deck.box_binder && !own.has(deck.box_binder.toLowerCase()) ? deck.box_binder.toLowerCase() : null;
  const rank = (r) => (prevBox && r.binder.toLowerCase() === prevBox ? -1 : r.binder === "" ? 0
    : r.binder.toLowerCase().startsWith(DECK_BOX_PREFIX.toLowerCase()) ? 2 : 1);
  return { target, protectedBinders, reservedBoxes, isOwn, rank };
}

/**
 * Put the owned copies a deck needs (commander+main+side) into one binder,
 * default the deck's remembered box (decks.box_binder), else "Deck box: <deck name>";
 * the binder used is remembered. Copies already in that binder or in the deck's own
 * ManaBox deck binder count as boxed and stay. Others come from a previous box of this
 * deck first, then Unsorted, then binders that are not deck boxes; copies in any other deck
 * box (reserved, built deck or not, linked or not) or another BUILT deck's binders are never
 * taken. A built
 * deck may take copies another built deck also claims (a conflict: the first one boxed
 * gets them); an idea deck gathers at most available_for_this. Basic lands are moved when owned but never reported missing. Uses
 * moveCopies, so ManaBox copies need confirm_master once (409).
 * `keys` (card keys, lib/decks.js cardKey) limits the move to those cards (the build checklist's picks).
 * Returns {binder, created, moved_copies, converted_copies, moved:[{name, quantity, from:[{binder, quantity}]}],
 * missing:[{name, quantity}], missing_count, collection_master}.
 */
export function deckToBinder(db, deckId, { binder = null, confirm_master = false, keys = null } = {}) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) throw new BinderError(404, "Deck not found");
  if (binder != null && typeof binder !== "string") throw new BinderError(400, "binder must be a string");
  const { target, protectedBinders, isOwn, rank } = deckBoxContext(db, deck, binder);
  const alloc = allocation(db);
  const detail = deckDetail(db, deck.id, { alloc });
  const built = deck.status === "built";
  const only = keys ? new Set(keys) : null;

  const rowsByOracle = db.prepare(
    `SELECT col.* FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE c.oracle_id = ?`,
  );
  const rowsByName = db.prepare(
    `SELECT col.* FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE`,
  );
  const needs = new Map();
  for (const c of detail.cards) {
    if (!CLAIM_BOARDS.includes(c.board)) continue;
    const key = cardKey(c.oracle_id, c.name);
    if (only && !only.has(key)) continue;
    const e = needs.get(key) ?? { name: c.name, oracle_id: c.oracle_id, need: 0, available: c.available_for_this, basic: c.basic };
    e.need += c.quantity;
    needs.set(key, e);
  }
  const items = [];
  const moved = [];
  const missing = [];
  for (const e of needs.values()) {
    const rows = e.oracle_id ? rowsByOracle.all(e.oracle_id) : rowsByName.all(e.name, e.name);
    const already = rows.filter(isOwn).reduce((a, r) => a + r.quantity, 0);
    // Basics never conflict and a built deck may take contested copies (first boxed wins; the
    // conflict stays flagged), as long as they are not in another built deck's box. An idea
    // deck takes at most the copies that are free for it.
    const cap = e.basic || built ? e.need : Math.min(e.need, Math.max(0, e.available));
    let left = Math.max(0, cap - already);
    const from = [];
    const candidates = rows.filter((r) => !isOwn(r) && !protectedBinders.has(r.binder.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b) || bySourceOrder(a, b));
    for (const r of candidates) {
      if (!left) break;
      const n = Math.min(left, r.quantity);
      items.push({ scryfall_id: r.scryfall_id, finish: r.finish, language: r.language, condition: r.condition, binder: r.binder, source: r.source, quantity: n });
      const f = from.find((x) => sameBinder(x.binder, r.binder));
      if (f) f.quantity += n; else from.push({ binder: r.binder, quantity: n });
      left -= n;
    }
    const got = from.reduce((a, f) => a + f.quantity, 0);
    if (got) moved.push({ name: e.name, quantity: got, from });
    const short = e.need - already - got;
    if (short > 0 && !e.basic) missing.push({ name: e.name, quantity: short });
  }
  const missingCount = missing.reduce((a, m) => a + m.quantity, 0);
  const remember = (b) => { if (b && deck.box_binder !== b) db.prepare("UPDATE decks SET box_binder = ? WHERE id = ?").run(b, deck.id); };
  if (!items.length) {
    if (findBinder(db, target)) remember(findBinder(db, target));
    return { binder: target, created: false, moved_copies: 0, converted_copies: 0, moved, missing, missing_count: missingCount, collection_master: collectionMaster(db) };
  }
  const r = moveCopies(db, { items, to_binder: target, create: true, confirm_master });
  remember(r.to_binder);
  return {
    binder: r.to_binder, created: r.created, moved_copies: r.moved_copies, converted_copies: r.converted_copies,
    moved, missing, missing_count: missingCount, collection_master: r.collection_master,
  };
}
