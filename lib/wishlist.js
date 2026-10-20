// Wishlist: cards the user wants to buy that no deck asks for (or before a
// deck exists). Shared by the HTTP API, the global shopping list and the MCP
// server (Claude may list and add, never delete: deleting is app-only).
//
// An item names an oracle card plus a reference printing (image, price,
// price history key). any_printing 1 = any printing of the card will do: the
// price is the cheapest EUR price among the printings the app knows (`cards`
// table), and owned copies of every printing count. any_printing 0 = only that
// printing. finish/language narrow both the price and the owned count when
// set. Prices are EUR only (English-twin fallback, never USD). "Got it" =
// owned >= wanted; the item stays until the user removes it.

import { parsePrices, eurOf, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { resolveDeckItems } from "./deckresolve.js";
import { StatusError } from "./errors.js";

/** Wishlist error with an HTTP status for the API layer. */
export class WishlistError extends StatusError {}

export const WISH_FINISHES = ["normal", "foil", "etched"];
/** Priority names ↔ stored numbers (1 high, 2 normal, 3 low). */
export const WISH_PRIORITIES = { high: 1, normal: 2, low: 3 };
const PRIORITY_NAME = { 1: "high", 2: "normal", 3: "low" };
export const MAX_WISH_QUANTITY = 999;
const MAX_NOTE = 500;
const LANG_RE = /^[a-z]{2,3}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;

const round2 = (v) => Math.round(v * 100) / 100;
const PRICE_KEY = { normal: "eur", foil: "eur_foil", etched: "eur_etched" };

/** EUR price to buy one copy of a card row: the finish's price, else (any finish) nonfoil, foil, etched. */
function buyEur(prices, finish) {
  const p = parsePrices(prices);
  if (finish) return eurOf(p, PRICE_KEY[finish]);
  return eurOf(p, "eur") ?? eurOf(p, "eur_foil") ?? eurOf(p, "eur_etched");
}

// --- input validation ---------------------------------------------------------

function priorityOf(v) {
  if (v == null || v === "") return 2;
  if (typeof v === "string" && WISH_PRIORITIES[v.toLowerCase()]) return WISH_PRIORITIES[v.toLowerCase()];
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n;
  throw new WishlistError(400, "priority must be high, normal or low (1-3)");
}
function quantityOf(v, def = 1) {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WISH_QUANTITY) throw new WishlistError(400, `quantity must be 1-${MAX_WISH_QUANTITY}`);
  return n;
}
function maxPriceOf(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new WishlistError(400, "max_price_eur must be a positive number of euros");
  return round2(n);
}
function finishOf(v) {
  if (v == null || v === "" || v === "any") return null;
  const f = v === "nonfoil" ? "normal" : String(v);
  if (!WISH_FINISHES.includes(f)) throw new WishlistError(400, "finish must be normal, foil, etched or any");
  return f;
}
function languageOf(v) {
  if (v == null || v === "" || v === "any") return null;
  const l = String(v).toLowerCase();
  if (!LANG_RE.test(l)) throw new WishlistError(400, "language must be a language code like en, de, ja");
  return l;
}
function noteOf(v) {
  if (v == null) return null;
  if (typeof v !== "string") throw new WishlistError(400, "note must be text");
  return v.trim().slice(0, MAX_NOTE) || null;
}

// --- reading ------------------------------------------------------------------

/** One item with price, owned count and flags (the shape GET /api/wishlist returns). */
function decorate(db, w) {
  const ref = db.prepare("SELECT name, set_code, set_name, collector_number, lang, prices, image_small, image_normal FROM cards WHERE scryfall_id = ?").get(w.scryfall_id) ?? {};
  let price = null;
  let priceId = null;
  if (w.any_printing) {
    const rows = db.prepare(`SELECT scryfall_id, prices FROM cards WHERE oracle_id = ?${w.language ? " AND lang = ?" : ""}`)
      .all(...(w.language ? [w.oracle_id, w.language] : [w.oracle_id]));
    for (const r of rows) {
      const v = buyEur(r.prices, w.finish);
      if (v != null && (price == null || v < price)) { price = v; priceId = r.scryfall_id; }
    }
  } else {
    price = buyEur(ref.prices, w.finish);
    priceId = price == null ? null : w.scryfall_id;
  }
  const where = ["c.oracle_id = ?"];
  const args = [w.oracle_id];
  if (!w.any_printing) { where.push("col.scryfall_id = ?"); args.push(w.scryfall_id); }
  if (w.finish) { where.push("col.finish = ?"); args.push(w.finish); }
  if (w.language) { where.push("col.language = ?"); args.push(w.language); }
  const owned = db.prepare(`SELECT COALESCE(SUM(col.quantity), 0) AS n FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE ${where.join(" AND ")}`)
    .get(...args).n;
  const toBuy = Math.max(0, w.quantity - owned);
  return {
    id: w.id, oracle_id: w.oracle_id, name: w.name, scryfall_id: w.scryfall_id, any_printing: Boolean(w.any_printing),
    finish: w.finish, language: w.language, quantity: w.quantity, max_price_eur: w.max_price_eur, note: w.note,
    priority: PRIORITY_NAME[w.priority] ?? "normal", source: w.source, created_at: w.created_at, updated_at: w.updated_at,
    set_code: ref.set_code ?? null, set_name: ref.set_name ?? null, collector_number: ref.collector_number ?? null, lang: ref.lang ?? null,
    image_small: ref.image_small ?? null, image_normal: ref.image_normal ?? null,
    price_eur: price, price_printing_id: priceId, owned, got_it: owned >= w.quantity, to_buy: toBuy,
    cost_eur: price == null ? null : round2(price * toBuy),
    below_max: price != null && w.max_price_eur != null && price <= w.max_price_eur,
  };
}

const ORDER = "ORDER BY priority, created_at, id";

/**
 * The wishlist: {items, totals{items, to_buy, to_buy_eur, unpriced, got_it, below_max}}.
 * Items: priority order, got-it items last.
 */
export function listWishlist(db) {
  const items = db.prepare(`SELECT * FROM wishlist ${ORDER}`).all().map((w) => decorate(db, w));
  items.sort((a, b) => Number(a.got_it) - Number(b.got_it));
  const open = items.filter((i) => !i.got_it);
  return {
    items,
    totals: {
      items: items.length,
      to_buy: open.reduce((a, i) => a + i.to_buy, 0),
      to_buy_eur: round2(open.reduce((a, i) => a + (i.cost_eur ?? 0), 0)),
      unpriced: open.filter((i) => i.price_eur == null).length,
      got_it: items.length - open.length,
      below_max: open.filter((i) => i.below_max).length,
    },
  };
}

/** One item (decorated) or null. */
export function getWishlistItem(db, id) {
  const w = db.prepare("SELECT * FROM wishlist WHERE id = ?").get(Number(id));
  return w ? decorate(db, w) : null;
}

/** Shopping-list section: the open items {items[{id, name, oracle_id, need, price_eur, cost_eur, max_price_eur, below_max, priority}], total_eur}. */
export function wishlistShopping(db) {
  const { items, totals } = listWishlist(db);
  return {
    items: items.filter((i) => !i.got_it).map((i) => ({
      id: i.id, name: i.name, oracle_id: i.oracle_id, need: i.to_buy, price_eur: i.price_eur, cost_eur: i.cost_eur,
      max_price_eur: i.max_price_eur, below_max: i.below_max, priority: i.priority, any_printing: i.any_printing,
      set_code: i.set_code, collector_number: i.collector_number, finish: i.finish,
    })),
    total_eur: totals.to_buy_eur,
  };
}

// --- writing ------------------------------------------------------------------

/** The card row for a Scryfall id: the local `cards` row, else fetched from Scryfall (stored). */
async function cardById(db, id) {
  const row = db.prepare("SELECT scryfall_id, oracle_id, name FROM cards WHERE scryfall_id = ?").get(id);
  if (row) return row;
  const { cards } = await fetchCollection([{ id }]);
  if (!cards.length) throw new WishlistError(404, "Card not found on Scryfall");
  upsertCards(db, cards.map(normalizeCard));
  return db.prepare("SELECT scryfall_id, oracle_id, name FROM cards WHERE scryfall_id = ?").get(id);
}

/** Resolve the input to a card row {scryfall_id, oracle_id, name}. */
async function resolveCard(db, input) {
  if (input.scryfall_id != null) {
    if (!ID_RE.test(String(input.scryfall_id))) throw new WishlistError(400, "scryfall_id is not a Scryfall id");
    return cardById(db, String(input.scryfall_id).toLowerCase());
  }
  if (input.oracle_id != null) {
    const row = db.prepare(
      `SELECT c.scryfall_id, c.oracle_id, c.name FROM cards c WHERE c.oracle_id = ?
        ORDER BY (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE scryfall_id = c.scryfall_id) DESC, c.lang = 'en' DESC, c.fetched_at DESC LIMIT 1`,
    ).get(String(input.oracle_id));
    if (row) return row;
    if (!input.name) throw new WishlistError(404, "Unknown card: send scryfall_id or name");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new WishlistError(400, "scryfall_id, oracle_id or name is required");
  if (!input.set) {
    const row = db.prepare(
      `SELECT scryfall_id, oracle_id, name FROM cards WHERE name = ? COLLATE NOCASE OR name LIKE ? || ' // %' COLLATE NOCASE
        ORDER BY lang = 'en' DESC, fetched_at DESC LIMIT 1`,
    ).get(name, name);
    if (row) return row;
  }
  const { rows } = await resolveDeckItems(db, [{ name, quantity: 1, set: input.set || undefined, collector_number: input.collector_number ?? undefined }]);
  const id = rows[0]?.scryfall_id;
  if (!id) throw new WishlistError(404, `No card named "${name}"${input.set ? ` in set ${input.set}` : ""} found on Scryfall`);
  return db.prepare("SELECT scryfall_id, oracle_id, name FROM cards WHERE scryfall_id = ?").get(id);
}

/**
 * Add a card: {scryfall_id | oracle_id | name (+ set, collector_number)},
 * any_printing (default: true unless a scryfall_id or set was given), finish,
 * language, quantity, max_price_eur, note, priority, source app|claude.
 * The same card + printing rule + finish + language already on the list is
 * merged (quantity added, other given fields replaced). Returns {item, merged}.
 */
export async function addWishlistItem(db, input = {}, { source = "app" } = {}) {
  const quantity = quantityOf(input.quantity);
  const finish = finishOf(input.finish);
  const language = languageOf(input.language);
  const maxPrice = maxPriceOf(input.max_price_eur);
  const note = noteOf(input.note);
  const priority = input.priority === undefined ? null : priorityOf(input.priority);
  const anyPrinting = input.any_printing === undefined ? !(input.scryfall_id || input.set) : Boolean(input.any_printing);
  const card = await resolveCard(db, input);
  const existing = db.prepare(
    `SELECT * FROM wishlist WHERE oracle_id = ? AND any_printing = ? AND (any_printing = 1 OR scryfall_id = ?)
       AND finish IS ? AND language IS ? LIMIT 1`,
  ).get(card.oracle_id, anyPrinting ? 1 : 0, card.scryfall_id, finish, language);
  if (existing) {
    db.prepare(
      `UPDATE wishlist SET quantity = MIN(?, quantity + ?), max_price_eur = COALESCE(?, max_price_eur), note = COALESCE(?, note),
         priority = COALESCE(?, priority), updated_at = datetime('now') WHERE id = ?`,
    ).run(MAX_WISH_QUANTITY, quantity, maxPrice, note, priority, existing.id);
    return { item: getWishlistItem(db, existing.id), merged: true };
  }
  const info = db.prepare(
    `INSERT INTO wishlist (oracle_id, name, scryfall_id, any_printing, finish, language, quantity, max_price_eur, note, priority, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(card.oracle_id, card.name, card.scryfall_id, anyPrinting ? 1 : 0, finish, language, quantity, maxPrice, note, priority ?? 2,
    source === "claude" ? "claude" : "app");
  return { item: getWishlistItem(db, Number(info.lastInsertRowid)), merged: false };
}

/** Change an item: quantity, max_price_eur (null clears), note, priority, finish, language, any_printing. Returns the item. */
export function updateWishlistItem(db, id, patch = {}) {
  const w = db.prepare("SELECT * FROM wishlist WHERE id = ?").get(Number(id));
  if (!w) throw new WishlistError(404, "Wishlist item not found");
  const set = {};
  if (patch.quantity !== undefined) set.quantity = quantityOf(patch.quantity);
  if (patch.max_price_eur !== undefined) set.max_price_eur = maxPriceOf(patch.max_price_eur);
  if (patch.note !== undefined) set.note = noteOf(patch.note);
  if (patch.priority !== undefined) set.priority = priorityOf(patch.priority);
  if (patch.finish !== undefined) set.finish = finishOf(patch.finish);
  if (patch.language !== undefined) set.language = languageOf(patch.language);
  if (patch.any_printing !== undefined) set.any_printing = patch.any_printing ? 1 : 0;
  const cols = Object.keys(set);
  if (cols.length) {
    db.prepare(`UPDATE wishlist SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => set[c]), w.id);
  }
  return getWishlistItem(db, w.id);
}

/** Remove an item (app only; the MCP server has no delete tool). True when it existed. */
export function deleteWishlistItem(db, id) {
  return db.prepare("DELETE FROM wishlist WHERE id = ?").run(Number(id)).changes > 0;
}

export const MAX_WISH_DELETE = 1000;
/**
 * Remove several items at once (app only, the Wishlist's Select mode). ids: item ids (1-1000,
 * duplicates ignored); ids that don't exist any more are skipped. Returns the number removed.
 */
export function deleteWishlistItems(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new WishlistError(400, "ids must be a non-empty array");
  if (ids.length > MAX_WISH_DELETE) throw new WishlistError(400, `At most ${MAX_WISH_DELETE} items at once`);
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) throw new WishlistError(400, "ids must be item ids");
  const del = db.prepare("DELETE FROM wishlist WHERE id = ?");
  let removed = 0;
  db.exec("BEGIN");
  try {
    for (const id of new Set(ids)) removed += del.run(id).changes;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return removed;
}

/**
 * The wishlist as a text list to paste into a shop or deck site: one line per item you still
 * need ("got it" items left out), "<copies to buy> <name>", plus " (SET) <number>" when only that
 * printing will do and " *F*" / " *E*" for foil / etched (the Moxfield / MTGA list style).
 */
export function wishlistText(db) {
  const lines = listWishlist(db).items.filter((i) => !i.got_it && i.to_buy > 0).map((i) => {
    const printing = !i.any_printing && i.set_code ? ` (${i.set_code.toUpperCase()}) ${i.collector_number}` : "";
    const finish = i.finish === "foil" ? " *F*" : i.finish === "etched" ? " *E*" : "";
    return `${i.to_buy} ${i.name}${printing}${finish}`;
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}
