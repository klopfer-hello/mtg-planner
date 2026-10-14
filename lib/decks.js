// Decks: decklist parsing, name → printing resolution (owned printings first),
// persistence, and ownership coverage against the collection.
//
// Allocation: a deck is an 'idea' (a plan, claims nothing) or 'built' (a
// physical deck). Built decks CLAIM owned copies, counted per oracle card
// across all printings, from the commander+main+side boards (never maybe):
//   owned(card)        every copy in the collection
//   built_demand(card) sum over built decks
//   available(card)    owned - built_demand (negative = short)
// Seen from one deck, used_elsewhere is the demand of the OTHER built decks and
// available_for_this = owned - used_elsewhere. The copies a deck needs split into
//   covered  free copies (min(need, free))
//   in_use   owned, but claimed by other built decks: can be moved over, so they
//            are not bought (min(need, owned) - covered)
//   to_buy   copies the user does not own at all (need - owned); only these are
//            "missing" (missing_count, shopping list, to-buy cost)
// Basic lands never conflict and are never to buy or in use.

import { cardPrice, eurOf, formatPrice, parsePrices, transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";

export const BOARDS = ["commander", "main", "side", "maybe"];
/** Boards whose copies a built deck claims. */
export const CLAIM_BOARDS = ["commander", "main", "side"];
export const DECK_STATUSES = ["idea", "built"];
export const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);
export const isBasicLand = (name) => BASIC_LANDS.has(String(name || "").toLowerCase());

/** Allocation key of a card: its oracle id, else (unresolved deck rows) its lower-cased name. */
export const cardKey = (oracleId, name) => oracleId ?? `name:${String(name || "").toLowerCase()}`;

/**
 * Snapshot of ownership and built-deck claims: {ownedOf(key, name), built: Map key ->
 * {name, oracle_id, demand, decks:[{deck_id, name, status, quantity}]}}. Compute it
 * once and pass it to deckDetail/cardUsage when handling several decks.
 */
export function allocation(db) {
  const owned = new Map();
  for (const r of db.prepare(
    `SELECT c.oracle_id, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id IS NOT NULL GROUP BY c.oracle_id`,
  ).all()) owned.set(r.oracle_id, r.q);
  const byName = db.prepare(
    `SELECT COALESCE(SUM(col.quantity), 0) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE`,
  );
  const ownedOf = (key, name) => {
    if (owned.has(key)) return owned.get(key);
    if (!key.startsWith("name:")) return 0;
    const q = byName.get(name, name).q;
    owned.set(key, q);
    return q;
  };
  const built = new Map();
  const rows = db.prepare(
    `SELECT d.id AS deck_id, d.name AS deck_name, d.status, c.oracle_id, MIN(dc.name) AS card_name, SUM(dc.quantity) AS q
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side')
      GROUP BY d.id, COALESCE(c.oracle_id, 'name:' || lower(dc.name))
      ORDER BY d.name COLLATE NOCASE, d.id`,
  ).all();
  for (const r of rows) {
    const key = cardKey(r.oracle_id, r.card_name);
    const e = built.get(key) ?? { name: r.card_name, oracle_id: r.oracle_id, demand: 0, decks: [] };
    e.demand += r.q;
    e.decks.push({ deck_id: r.deck_id, name: r.deck_name, status: r.status, quantity: r.q });
    built.set(key, e);
  }
  return { ownedOf, built };
}

/**
 * Usage of one card: {owned, built_demand, available, decks:[{id, name, status, board, quantity}]}
 * (decks = every deck holding the card, any status and board).
 */
export function cardUsage(db, { oracle_id: oracleId = null, name = "" } = {}, alloc = allocation(db)) {
  const key = cardKey(oracleId, name);
  const owned = alloc.ownedOf(key, name);
  const demand = alloc.built.get(key)?.demand ?? 0;
  const decks = db.prepare(
    `SELECT d.id, d.name, d.status, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (c.oracle_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board
      ORDER BY CASE d.status WHEN 'built' THEN 0 ELSE 1 END, d.name COLLATE NOCASE, d.id,
               CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END`,
  ).all(oracleId, name);
  // Basic lands never conflict: every owned basic counts as free.
  const basic = isBasicLand(name || alloc.built.get(key)?.name);
  return { owned, built_demand: demand, available: basic ? owned : owned - demand, basic, decks };
}

/** Set a deck's status ('idea' | 'built'). Returns the deck row. */
export function setDeckStatus(db, deckId, status) {
  if (!DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const deck = requireDeck(db, deckId);
  db.prepare("UPDATE decks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, deck.id);
  return db.prepare("SELECT * FROM decks WHERE id = ?").get(deck.id);
}

const SECTION = [
  [/^(commanders?|command zone)\b/i, "commander"],
  [/^(sideboard|side)\b/i, "side"],
  [/^(maybe(board)?|considering)\b/i, "maybe"],
  [/^(deck|main(board|deck)?|companion)\b/i, "main"],
];
// "1 Sol Ring", "1x Sol Ring (C21) 263", "SB: 2 Duress", "1 Arcane Signet (CMM) 1015 *F*"
const LINE = /^(?:(SB|CMDR):\s*)?(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([^\s*]+))?)?(?:\s+\*[A-Z]+\*)*\s*$/;

/** Parse a text decklist (ManaBox / MTGA / Moxfield style). */
export function parseDecklist(text) {
  let board = "main";
  const items = [];
  const errors = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const section = SECTION.find(([re]) => re.test(line) && !/^\d/.test(line));
    if (section && line.replace(/[:\s]/g, "").length <= 14) { board = section[1]; continue; }
    const m = line.match(LINE);
    if (!m) { errors.push(line); continue; }
    const [, prefix, qty, name, set, number] = m;
    items.push({
      quantity: parseInt(qty, 10),
      name: name.trim(),
      set: set?.toLowerCase(),
      collector_number: number,
      board: prefix === "SB" ? "side" : prefix === "CMDR" ? "commander" : board,
    });
  }
  return { items, errors };
}

function ownedPrintingByName(db, name) {
  return db.prepare(
    `SELECT c.scryfall_id, c.name FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE
      GROUP BY c.scryfall_id ORDER BY SUM(col.quantity) DESC LIMIT 1`,
  ).get(name, name);
}

/**
 * Resolve {name, quantity, board, set?, collector_number?} items to deck rows.
 * Name-only items prefer a printing the user owns; everything else is looked
 * up on Scryfall. Returns { rows, unresolved }.
 */
export async function resolveDeckItems(db, items) {
  const rows = [];
  const lookups = [];
  for (const item of items) {
    const board = BOARDS.includes(item.board) ? item.board : "main";
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    if (!item.set) {
      const owned = ownedPrintingByName(db, item.name);
      if (owned) { rows.push({ name: owned.name, scryfall_id: owned.scryfall_id, quantity, board }); continue; }
    }
    lookups.push({ item: { ...item, board, quantity },
      ident: item.set && item.collector_number ? { set: item.set, collector_number: String(item.collector_number) }
        : item.set ? { name: item.name, set: item.set } : { name: item.name } });
  }
  const unresolved = [];
  if (lookups.length) {
    const { cards } = await fetchCollection(lookups.map((l) => l.ident));
    upsertCards(db, cards.map(normalizeCard));
    const norm = (s) => s.toLowerCase();
    for (const { item, ident } of lookups) {
      const card = cards.find((c) => ident.collector_number
        ? c.set === ident.set && c.collector_number === ident.collector_number
        : norm(c.name) === norm(item.name) || norm(c.name).startsWith(norm(item.name) + " // ")
          || (c.card_faces || []).some((f) => norm(f.name) === norm(item.name)));
      if (card) rows.push({ name: card.name, scryfall_id: card.id, quantity: item.quantity, board: item.board });
      else { unresolved.push(item.name); rows.push({ name: item.name, scryfall_id: null, quantity: item.quantity, board: item.board }); }
    }
  }
  return { rows, unresolved };
}

/**
 * Create or replace a deck's contents. Must run inside a transaction when
 * called alongside other writes. With matchByName, an existing deck of the same
 * name and source is replaced instead of creating a duplicate. With append,
 * the rows are merged into the existing cards instead of replacing them.
 */
export function saveDeckRows(db, { id, name, format = null, description = null, source = "manual", status = null, rows, matchByName = false, append = false }) {
  format = normalizeFormat(format);
  if (status != null && !DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  let deckId = id;
  let keepName = false;
  if (!deckId && matchByName) {
    // ManaBox decks match on their binder, so a deck renamed in the app keeps its name and is not recreated.
    deckId = source === "manabox" ? findManaboxDeck(db, name)?.id
      : db.prepare("SELECT id FROM decks WHERE name = ? AND source = ?").get(name, source)?.id;
    keepName = source === "manabox";
  }
  if (deckId) {
    const existing = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
    if (!existing) throw new Error(`Deck ${deckId} not found`);
    db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(keepName ? existing.name : name ?? existing.name, format ?? existing.format, description ?? existing.description, status ?? existing.status, deckId);
    if (!append) db.prepare("DELETE FROM deck_cards WHERE deck_id = ?").run(deckId);
  } else {
    // ManaBox binder decks are physical decks; everything else starts as an idea.
    deckId = Number(db.prepare("INSERT INTO decks (name, format, description, source, status, manabox_binder) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, format, description, source, status ?? (source === "manabox" ? "built" : "idea"), source === "manabox" ? name : null).lastInsertRowid);
  }
  const insert = db.prepare(
    `INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (deck_id, board, name) DO UPDATE SET quantity = quantity + excluded.quantity`,
  );
  for (const r of rows) insert.run(deckId, r.board, r.name, r.scryfall_id, r.quantity);
  return deckId;
}

/** The ManaBox deck synced from binder `binder` (its stored binder name, else its name), or undefined. */
export function findManaboxDeck(db, binder) {
  return db.prepare(
    `SELECT * FROM decks WHERE source = 'manabox'
       AND (manabox_binder = ? COLLATE NOCASE OR (manabox_binder IS NULL AND name = ? COLLATE NOCASE))
     ORDER BY manabox_binder IS NULL, id LIMIT 1`,
  ).get(binder, binder);
}

/** Resolve items and save; status (idea|built) defaults to idea for new decks and is kept on update. */
export async function saveDeck(db, { id, name, format, description, source, status = null, items, matchByName }) {
  if (status != null && !DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const { rows, unresolved } = await resolveDeckItems(db, items);
  const deckId = transaction(db, () => saveDeckRows(db, { id, name, format, description, source, status, rows, matchByName }));
  return { id: deckId, unresolved };
}

export function findDeck(db, ref) {
  if (ref == null || ref === "") return null;
  if (/^\d+$/.test(String(ref))) {
    const d = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(ref));
    if (d) return d;
  }
  return db.prepare("SELECT * FROM decks WHERE name = ? COLLATE NOCASE ORDER BY updated_at DESC").get(String(ref))
    ?? db.prepare("SELECT * FROM decks WHERE name LIKE ? ORDER BY updated_at DESC").get(`%${ref}%`);
}

/**
 * Decks, newest first, with card_count, value_eur (commander+main+side, EUR only), status, conflict_count,
 * to_buy_count (= missing_count), missing_cost_eur (to-buy cost), in_use_count and in_use_eur.
 */
export function listDecks(db) {
  const decks = db.prepare(
    `SELECT d.*, COALESCE(SUM(dc.quantity), 0) AS card_count
       FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      GROUP BY d.id ORDER BY d.updated_at DESC`,
  ).all();
  const alloc = allocation(db);
  for (const d of decks) {
    const detail = deckDetail(db, d.id, { alloc });
    d.value_eur = detail?.value.total_eur ?? 0;
    d.conflict_count = detail?.conflict_count ?? 0;
    d.missing_count = detail?.missing_count ?? 0;
    d.to_buy_count = detail?.to_buy_count ?? 0;
    d.missing_cost_eur = detail?.missing_cost_eur ?? 0;
    d.in_use_count = detail?.in_use_count ?? 0;
    d.in_use_eur = detail?.in_use_eur ?? 0;
  }
  return decks;
}

const round2 = (v) => Math.round(v * 100) / 100;
/**
 * EUR price of a printing for one finish exactly (eur / eur_foil / eur_etched), or null. Never USD.
 * A foreign printing without its own price uses its English twin's (db.js eurOf).
 */
export function eurForFinish(prices, finish = "normal") {
  return eurOf(parsePrices(prices), finish === "foil" ? "eur_foil" : finish === "etched" ? "eur_etched" : "eur");
}

/** EUR price of a printing to buy: nonfoil eur, else (foil/etched-only printings) the foil/etched eur (English twin fallback). Never USD. */
export function eurOfPrinting(prices) {
  const p = parsePrices(prices);
  return eurOf(p, "eur") ?? eurOf(p, "eur_foil") ?? eurOf(p, "eur_etched");
}

/** Canonical stored format: trimmed + lowercase ("Commander " -> "commander"), null when empty. */
export function normalizeFormat(format) {
  return typeof format === "string" && format.trim() ? format.trim().toLowerCase().slice(0, 50) : null;
}
const isCommanderFormat = (deck) => normalizeFormat(deck?.format) === "commander";

/**
 * Deck with per-card ownership (counted across all printings of the card) and
 * its EUR value. Owned copies are valued at the price of the owned printing and
 * finish (else the deck printing's EUR price), missing copies at the deck
 * printing's EUR price; USD is never mixed in (cards without any EUR price are
 * counted in value.no_eur_price instead).
 *
 * Allocation (see the header): per card {owned, available_for_this,
 * used_elsewhere:[{deck_id, name, status, quantity}], conflict, to_buy, in_use,
 * missing (= to_buy since v0.3.1; before, copies in use elsewhere counted too)}.
 * Owned copies are shared across the card's rows in board order. Deck level
 * (maybe board excluded from every count): status, conflicts (built deck only:
 * cards whose built demand exceeds what is owned while another built deck also
 * claims them), conflict_count, to_buy_count (= missing_count), in_use_count,
 * missing_cost_eur (= value.to_buy_eur), in_use_eur (buying those instead, at
 * the deck printing's EUR) and shopping {items:[{name, oracle_id, need,
 * price_eur, cost_eur}], total_eur, in_use:[{name, oracle_id, quantity,
 * decks:[{id, name}], conflict, price_eur, cost_eur}], in_use_eur}.
 * In-use copies are valued as owned (value.owned_eur); value.in_use_eur = in_use_eur.
 * opts.alloc: a precomputed allocation(db).
 */
export function deckDetail(db, deckId, { alloc = null } = {}) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
  if (!deck) return null;
  alloc ??= allocation(db);
  const built = deck.status === "built";
  const cards = db.prepare(
    `SELECT dc.board, dc.name, dc.quantity, dc.scryfall_id, c.oracle_id, c.type_line, c.mana_cost, c.cmc,
            c.colors, c.color_identity, c.rarity, c.set_code, c.collector_number, c.prices, c.image_small, c.image_normal
       FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ?
      ORDER BY CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END, c.cmc, dc.name`,
  ).all(deckId);
  // Every owned copy of the card (all printings), with its finish price.
  const ownedRowsStmt = db.prepare(
    `SELECT col.quantity, col.finish, c.prices FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? OR (? IS NULL AND (c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE))
      ORDER BY col.id`,
  );
  // This deck's claim per card (commander+main+side), for the conflict check.
  const ownDemand = new Map();
  for (const card of cards) {
    if (!CLAIM_BOARDS.includes(card.board)) continue;
    const key = cardKey(card.oracle_id, card.name);
    ownDemand.set(key, (ownDemand.get(key) ?? 0) + card.quantity);
  }
  let missingCount = 0;
  let inUseCount = 0;
  const inUse = new Map();
  const neededByOracle = new Map();
  const ownedCopies = new Map(); // key -> [{eur|null}] expanded per copy (capped)
  const conflicts = new Map();
  const shopping = new Map();
  const value = { total_eur: 0, owned_eur: 0, to_buy_eur: 0, in_use_eur: 0, maybe_eur: 0, no_eur_price: 0 };
  for (const card of cards) {
    const basic = isBasicLand(card.name);
    const key = cardKey(card.oracle_id, card.name);
    if (!ownedCopies.has(key)) {
      const copies = [];
      for (const r of ownedRowsStmt.all(card.oracle_id, card.oracle_id, card.name, card.name)) {
        const eur = eurForFinish(r.prices, r.finish);
        for (let i = 0; i < r.quantity && copies.length < 10000; i++) copies.push(eur);
      }
      ownedCopies.set(key, copies);
    }
    const copies = ownedCopies.get(key);
    const owned = alloc.ownedOf(key, card.name);
    const claims = alloc.built.get(key);
    const usedElsewhere = (claims?.decks ?? []).filter((d) => d.deck_id !== deck.id);
    const elsewhere = usedElsewhere.reduce((a, d) => a + d.quantity, 0);
    const availableForThis = owned - elsewhere;
    // The same card can sit in several boards; free copies are shared between them.
    const alreadyUsed = neededByOracle.get(key) ?? 0;
    neededByOracle.set(key, alreadyUsed + card.quantity);
    card.owned = owned;
    card.basic = basic;
    card.available_for_this = availableForThis;
    card.used_elsewhere = usedElsewhere;
    const ownedLeft = Math.max(0, owned - alreadyUsed);
    const freeLeft = basic ? ownedLeft : Math.max(0, Math.max(0, availableForThis) - alreadyUsed);
    card.to_buy = basic ? 0 : Math.max(0, card.quantity - ownedLeft);
    card.in_use = basic ? 0 : Math.min(card.quantity, ownedLeft) - Math.min(card.quantity, freeLeft);
    card.missing = card.to_buy;
    const demand = elsewhere + (built ? ownDemand.get(key) ?? 0 : 0);
    card.conflict = built && !basic && CLAIM_BOARDS.includes(card.board) && usedElsewhere.length > 0 && demand > owned;
    if (card.conflict && !conflicts.has(key)) {
      conflicts.set(key, { name: card.name, oracle_id: card.oracle_id, owned, demand, decks: claims.decks });
    }
    const price = card.prices ? cardPrice(card) : null;
    card.price = price;
    const unitEur = eurOfPrinting(card.prices);
    if (card.missing && card.board !== "maybe") {
      missingCount += card.missing;
      const item = shopping.get(key) ?? { name: card.name, oracle_id: card.oracle_id, need: 0, price_eur: unitEur, cost_eur: null };
      item.need += card.missing;
      if (item.price_eur == null) item.price_eur = unitEur;
      shopping.set(key, item);
    }
    if (card.in_use && card.board !== "maybe") {
      inUseCount += card.in_use;
      const item = inUse.get(key) ?? { name: card.name, oracle_id: card.oracle_id, quantity: 0,
        decks: usedElsewhere.map((d) => ({ id: d.deck_id, name: d.name })), conflict: false, price_eur: unitEur, cost_eur: null };
      item.quantity += card.in_use;
      item.conflict ||= card.conflict;
      if (item.price_eur == null) item.price_eur = unitEur;
      // Same per-row pricing as value.in_use_eur, so header and in-use list agree.
      if (unitEur != null) item.cost_eur = (item.cost_eur ?? 0) + unitEur * card.in_use;
      inUse.set(key, item);
    }

    // Value: owned copies at their own finish price, the rest at the deck printing's EUR price.
    const ownedUsed = card.quantity - card.missing;
    let ownedVal = 0, buyVal = 0, noPrice = 0;
    for (let i = 0; i < ownedUsed; i++) {
      const eur = copies[alreadyUsed + i] ?? unitEur;
      if (eur == null) noPrice++; else ownedVal += eur;
    }
    if (unitEur == null) noPrice += card.missing; else buyVal += unitEur * card.missing;
    card.eur = unitEur;
    card.value_eur = noPrice === card.quantity ? null : round2(ownedVal + buyVal);
    if (card.board === "maybe") {
      value.maybe_eur += ownedVal + buyVal;
    } else {
      value.owned_eur += ownedVal;
      value.to_buy_eur += buyVal;
      if (unitEur != null) value.in_use_eur += unitEur * card.in_use;
      value.no_eur_price += noPrice;
    }
  }
  value.owned_eur = round2(value.owned_eur);
  value.to_buy_eur = round2(value.to_buy_eur);
  value.in_use_eur = round2(value.in_use_eur);
  value.maybe_eur = round2(value.maybe_eur);
  value.total_eur = round2(value.owned_eur + value.to_buy_eur);
  const items = [...shopping.values()];
  for (const it of items) it.cost_eur = it.price_eur == null ? null : round2(it.price_eur * it.need);
  items.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const inUseItems = [...inUse.values()];
  for (const it of inUseItems) it.cost_eur = it.cost_eur == null ? null : round2(it.cost_eur);
  inUseItems.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const count = (board) => cards.filter((c) => c.board === board).reduce((a, c) => a + c.quantity, 0);
  const detail = {
    ...deck,
    cards,
    counts: Object.fromEntries(BOARDS.map((b) => [b, count(b)])),
    missing_count: missingCount,
    to_buy_count: missingCount,
    in_use_count: inUseCount,
    missing_cost_eur: value.to_buy_eur,
    in_use_eur: value.in_use_eur,
    value,
    conflicts: [...conflicts.values()],
    conflict_count: conflicts.size,
    shopping: {
      items, total_eur: round2(items.reduce((a, it) => a + (it.cost_eur ?? 0), 0)),
      in_use: inUseItems, in_use_eur: value.in_use_eur,
    },
  };
  if (isCommanderFormat(deck) && detail.counts.commander === 0) detail.commander_suggestions = commanderSuggestions(db, deckId);
  return detail;
}

/**
 * Everything the built decks are short of, plus each deck's to-buy and in-use counts:
 * {built: {items:[{name, oracle_id, short, decks:[{deck_id, name, status, quantity}], price_eur, cost_eur}],
 * total_eur}, per_deck:[{id, name, status, missing_count (= to_buy_count), missing_eur (to-buy cost),
 * to_buy_count, in_use_count, in_use_eur}]}.
 * price_eur is the cheapest EUR price among the printings the decks list.
 */
export function shoppingList(db) {
  const alloc = allocation(db);
  const priceStmt = db.prepare(
    `SELECT c.prices FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side')
        AND (c.oracle_id = ? OR (? IS NULL AND dc.name = ? COLLATE NOCASE))`,
  );
  const items = [];
  for (const [key, e] of alloc.built) {
    if (isBasicLand(e.name)) continue;
    const short = e.demand - alloc.ownedOf(key, e.name);
    if (short <= 0) continue;
    const prices = priceStmt.all(e.oracle_id, e.oracle_id, e.name).map((r) => eurOfPrinting(r.prices)).filter((v) => v != null);
    const price = prices.length ? Math.min(...prices) : null;
    items.push({ name: e.name, oracle_id: e.oracle_id, short, decks: e.decks, price_eur: price, cost_eur: price == null ? null : round2(price * short) });
  }
  items.sort((a, b) => (b.cost_eur ?? -1) - (a.cost_eur ?? -1) || a.name.localeCompare(b.name));
  const perDeck = db.prepare("SELECT id FROM decks ORDER BY CASE status WHEN 'built' THEN 0 ELSE 1 END, name COLLATE NOCASE, id").all()
    .map(({ id }) => {
      const d = deckDetail(db, id, { alloc });
      return {
        id: d.id, name: d.name, status: d.status, missing_count: d.missing_count, missing_eur: d.missing_cost_eur,
        to_buy_count: d.to_buy_count, in_use_count: d.in_use_count, in_use_eur: d.in_use_eur,
      };
    });
  return { built: { items, total_eur: round2(items.reduce((a, it) => a + (it.cost_eur ?? 0), 0)) }, per_deck: perDeck };
}

const CAN_BE_COMMANDER = /can be your commander/i;

/** Cards in the deck that could lead it: legendary creatures and "can be your commander" cards. */
export function commanderSuggestions(db, deckId) {
  const rows = db.prepare(
    `SELECT dc.name, dc.board, dc.scryfall_id, c.type_line, c.oracle_text, c.color_identity, c.image_small, c.image_normal
       FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ? AND dc.board <> 'commander'
      ORDER BY CASE dc.board WHEN 'main' THEN 0 WHEN 'side' THEN 1 ELSE 2 END, dc.name`,
  ).all(deckId);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const front = String(r.type_line || "").split(" // ")[0];
    const ok = (/\bLegendary\b/.test(front) && /\bCreature\b/.test(front)) || CAN_BE_COMMANDER.test(r.oracle_text || "");
    if (!ok || seen.has(r.name.toLowerCase())) continue;
    seen.add(r.name.toLowerCase());
    out.push({
      name: r.name, board: r.board, scryfall_id: r.scryfall_id, type_line: r.type_line, color_identity: r.color_identity,
      image_small: r.image_small, image_normal: r.image_normal,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing boards

/** Deck edit error with an HTTP status for the API layer. */
export class DeckError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireDeck(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) throw new DeckError(404, "Deck not found");
  return deck;
}

const touch = (db, deckId) => db.prepare("UPDATE decks SET updated_at = datetime('now') WHERE id = ?").run(deckId);

/** Add `quantity` copies of a card row to a board (merging into an existing row of that name). */
function addToBoard(db, deckId, board, row, quantity) {
  const existing = db.prepare("SELECT name, scryfall_id FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ? COLLATE NOCASE")
    .get(deckId, board, row.name);
  if (existing) {
    db.prepare("UPDATE deck_cards SET quantity = quantity + ?, scryfall_id = COALESCE(scryfall_id, ?) WHERE deck_id = ? AND board = ? AND name = ?")
      .run(quantity, row.scryfall_id, deckId, board, existing.name);
  } else {
    db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)")
      .run(deckId, board, row.name, row.scryfall_id, quantity);
  }
}

/** Take `quantity` copies off a board row (removing the row when none are left). */
function takeFromBoard(db, deckId, row, quantity) {
  if (quantity >= row.quantity) db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ?").run(deckId, row.board, row.name);
  else db.prepare("UPDATE deck_cards SET quantity = quantity - ? WHERE deck_id = ? AND board = ? AND name = ?").run(quantity, deckId, row.board, row.name);
}

const validQuantity = (q, { min = 0 } = {}) => {
  const n = typeof q === "string" && /^\d+$/.test(q) ? Number(q) : q;
  if (!Number.isInteger(n) || n < min || n > 999) throw new DeckError(400, `quantity must be an integer ${min}-999`);
  return n;
};

/**
 * Change one card row of a deck: {name, board, to_board?, quantity?}.
 * Without to_board, quantity sets the row's copies (0 removes the row).
 * With to_board, `quantity` copies (default all) move there, merging into a
 * row of the same name. Returns {deck_id, name, board, to_board, moved?, quantity?}.
 */
export function updateDeckCard(db, deckId, { name, board, to_board: toBoard, quantity } = {}) {
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "name is required");
    if (!BOARDS.includes(board)) throw new DeckError(400, `board must be one of ${BOARDS.join(", ")}`);
    if (toBoard != null && !BOARDS.includes(toBoard)) throw new DeckError(400, `to_board must be one of ${BOARDS.join(", ")}`);
    const row = db.prepare("SELECT * FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ? COLLATE NOCASE").get(deck.id, board, name.trim());
    if (!row) throw new DeckError(404, `"${name}" is not in the ${board} board`);
    let result;
    if (toBoard != null && toBoard !== board) {
      const n = quantity == null ? row.quantity : Math.min(row.quantity, validQuantity(quantity, { min: 1 }));
      takeFromBoard(db, deck.id, row, n);
      addToBoard(db, deck.id, toBoard, row, n);
      result = { deck_id: deck.id, name: row.name, board, to_board: toBoard, moved: n };
    } else {
      if (quantity == null) throw new DeckError(400, "quantity or to_board is required");
      const n = validQuantity(quantity);
      if (n === 0) db.prepare("DELETE FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ?").run(deck.id, board, row.name);
      else db.prepare("UPDATE deck_cards SET quantity = ? WHERE deck_id = ? AND board = ? AND name = ?").run(n, deck.id, board, row.name);
      result = { deck_id: deck.id, name: row.name, board, to_board: null, quantity: n };
    }
    touch(db, deck.id);
    return result;
  });
}

// Partner pairs: plain Partner / Friends forever on both sides, "Partner with X"
// naming each other, "Partner—V" with the same V, "Choose a Background" + a
// Background, or Doctor's companion + a Time Lord Doctor.
const textOf = (c) => `${c?.oracle_text || ""}\n${(() => { try { return JSON.parse(c?.keywords || "[]").join("\n"); } catch { return ""; } })()}`;
const norm = (x) => String(x || "").trim().toLowerCase();
/** Partner abilities from the oracle text (keywords only when there is no text). */
function partnerInfo(c) {
  const info = { generic: false, with: [], variants: [] };
  let lines = String(c?.oracle_text || "").split("\n");
  if (!c?.oracle_text) {
    let kw = [];
    try { kw = JSON.parse(c?.keywords || "[]"); } catch { /* ignore */ }
    // "Partner with" as a bare keyword names nobody we can check: never pairs.
    if (kw.some((k) => norm(k) === "partner with")) return info;
    lines = kw;
  }
  for (const raw of lines) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    const w = /^Partner with (.+)$/i.exec(line);
    if (w) { info.with.push(norm(w[1])); continue; }
    for (const part of line.split(",").map((p) => p.trim())) {
      const v = /^Partner\s*[—–-]\s*(.+)$/i.exec(part);
      if (v) info.variants.push(norm(v[1]));
      else if (/^Partner$/i.test(part)) info.generic = true;
    }
  }
  return info;
}
const nameMatches = (wanted, card) => {
  const n = norm(card?.name);
  return wanted === n || wanted === norm(n.split(" // ")[0]);
};
function canPair(a, b) {
  const pa = partnerInfo(a), pb = partnerInfo(b);
  if (pa.generic && pb.generic) return true;
  if (pa.with.some((w) => nameMatches(w, b)) && pb.with.some((w) => nameMatches(w, a))) return true;
  if (pa.variants.some((v) => pb.variants.includes(v))) return true;
  const ta = textOf(a), tb = textOf(b);
  if (/\bFriends forever\b/i.test(ta) && /\bFriends forever\b/i.test(tb)) return true;
  const bg = (x) => /\bBackground\b/.test(String(x?.type_line || ""));
  if ((/Choose a Background/i.test(ta) && bg(b)) || (/Choose a Background/i.test(tb) && bg(a))) return true;
  const doctor = (x) => /Time Lord Doctor/i.test(String(x?.type_line || ""));
  if ((/Doctor's companion/i.test(ta) && doctor(b)) || (/Doctor's companion/i.test(tb) && doctor(a))) return true;
  return false;
}

/**
 * Make `name` (a card already in the deck, any board) the commander: one copy
 * moves into the commander board. Format commander allows two commanders when
 * they can pair (partner, friends forever, background, doctor's companion);
 * otherwise the existing commander(s) move back to main. `replace` (a
 * commander's name) swaps out that one specifically.
 * Returns {deck_id, commanders: [names], replaced: [names]}.
 */
export function setCommander(db, deckId, { name, replace = null } = {}) {
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "name is required");
    const card = (n) => db.prepare(
      `SELECT dc.*, c.type_line, c.oracle_text, c.keywords FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE dc.deck_id = ? AND dc.name = ? COLLATE NOCASE
        ORDER BY CASE dc.board WHEN 'commander' THEN 0 WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END`,
    ).all(deck.id, n);
    const rows = card(name.trim());
    if (!rows.length) throw new DeckError(404, `"${name}" is not in this deck`);
    const commanders = () => db.prepare(
      `SELECT dc.*, c.type_line, c.oracle_text, c.keywords FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE dc.deck_id = ? AND dc.board = 'commander' ORDER BY dc.name`,
    ).all(deck.id);
    const replaced = [];
    if (rows[0].board !== "commander") {
      const src = rows[0];
      let current = commanders();
      const demote = (c) => { takeFromBoard(db, deck.id, c, c.quantity); addToBoard(db, deck.id, "main", c, c.quantity); replaced.push(c.name); };
      if (replace != null) {
        const r = current.find((c) => c.name.toLowerCase() === String(replace).trim().toLowerCase());
        if (!r) throw new DeckError(404, `"${replace}" is not a commander of this deck`);
        demote(r);
        current = commanders();
      }
      const keep = isCommanderFormat(deck) && current.length === 1 && current[0].quantity === 1 && canPair(current[0], src);
      if (!keep) for (const c of current) demote(c);
      takeFromBoard(db, deck.id, src, 1);
      addToBoard(db, deck.id, "commander", src, 1);
      touch(db, deck.id);
    }
    return { deck_id: deck.id, commanders: commanders().map((c) => c.name), replaced };
  });
}

/** ManaBox/Moxfield-importable text export. */
export function exportDeck(detail) {
  const label = { commander: "Commander", main: "Deck", side: "Sideboard", maybe: "Maybeboard" };
  const out = [];
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board);
    if (!cards.length) continue;
    if (out.length) out.push("");
    out.push(label[board]);
    for (const c of cards) out.push(`${c.quantity} ${c.name}${c.set_code ? ` (${c.set_code.toUpperCase()}) ${c.collector_number}` : ""}`);
  }
  return out.join("\n") + "\n";
}

/** Compact text rendering for Claude. */
export function deckToText(detail) {
  const status = detail.status === "built" ? "BUILT (physical deck, claims its cards)" : "idea (plan, claims nothing)";
  const lines = [`Deck #${detail.id} "${detail.name}"${detail.format ? ` [${detail.format}]` : ""} (source: ${detail.source}, status: ${status})`];
  if (detail.description) lines.push(detail.description);
  const built = detail.status === "built";
  const inUseEur = `~€${(detail.in_use_eur ?? 0).toFixed(2)}`;
  const inUseNote = !detail.in_use_count ? ""
    : built
      ? ` Shared with other built decks: ${detail.in_use_count} cards (CONFLICT: owned copies are needed by both built decks; buy extra ${inUseEur} to play all built decks at once).`
      : ` In other built decks: ${detail.in_use_count} cards (owned, can be moved over; buying them instead ${inUseEur}).`;
  lines.push(`Counts: ${BOARDS.map((b) => `${b} ${detail.counts[b]}`).join(", ")}. To buy (not owned at all): ${detail.missing_count} cards (~€${detail.missing_cost_eur.toFixed(2)}).${inUseNote}`);
  const v = detail.value;
  if (v) {
    lines.push(`Value: €${v.total_eur.toFixed(2)} (owned €${v.owned_eur.toFixed(2)}, to buy €${v.to_buy_eur.toFixed(2)}; maybeboard €${v.maybe_eur.toFixed(2)})`
      + (v.no_eur_price ? `; ${v.no_eur_price} cards have no EUR price.` : "."));
  }
  if (detail.conflicts?.length) {
    lines.push(`Conflicts (${detail.conflict_count}, cards also claimed by another built deck): ` + detail.conflicts.map((c) =>
      `${c.name} owned ${c.owned}, needed ${c.demand} (${c.decks.map((d) => `#${d.deck_id} ${d.name} ${d.quantity}x`).join(", ")})`).join("; "));
  }
  if (detail.shopping?.items.length) {
    const top = detail.shopping.items.slice(0, 10).map((it) => `${it.need}x ${it.name}${it.price_eur != null ? ` €${it.price_eur.toFixed(2)}` : ""}`);
    lines.push(`Shopping list: ${detail.shopping.items.length} cards, €${detail.shopping.total_eur.toFixed(2)}: ${top.join(", ")}${detail.shopping.items.length > 10 ? ", ..." : ""}`);
  }
  if (detail.shopping?.in_use?.length) {
    const list = detail.shopping.in_use;
    const top = list.slice(0, 10).map((it) => `${it.quantity}x ${it.name} (in ${it.decks.map((d) => d.name).join(", ")})`);
    lines.push(`${built ? "Shared with other built decks (both need them; buy extra to play both)" : "Owned but in other built decks (move them over instead of buying)"}: ${top.join(", ")}${list.length > 10 ? ", ..." : ""}`);
  }
  if (detail.commander_suggestions?.length) {
    lines.push(`No commander set. Possible commanders in the deck: ${detail.commander_suggestions.map((c) => c.name).join(", ")}.`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board);
    if (!cards.length) continue;
    lines.push(`\n## ${board}`);
    for (const c of cards) {
      const free = Math.max(0, c.available_for_this ?? c.owned);
      const elsewhere = (c.used_elsewhere ?? []).map((d) => d.name).join(", ");
      const parts = [];
      if (c.basic) parts.push("basic");
      else {
        if (c.to_buy) parts.push(`TO BUY ${c.to_buy}`);
        if (c.in_use) {
          parts.push(c.conflict
            ? `SHARED ${c.in_use} with ${elsewhere} (CONFLICT: both built decks need it; buy extra to play both)`
            : `IN USE ${c.in_use} in other deck(s): ${elsewhere} (can be moved)`);
        }
        parts.push(`owned ${c.owned}${free !== c.owned ? `, free ${free}` : ""}`);
        if (c.used_elsewhere?.length && !c.in_use && !c.conflict) parts.push(`also in ${elsewhere}`);
        if (c.conflict && !c.in_use) parts.push(`CONFLICT (also in ${elsewhere})`);
      }
      const own = parts.join(", ");
      lines.push(`${c.quantity}x ${c.name} | ${c.mana_cost || ""} | ${c.type_line || "?"} | ${own} | ${formatPrice(c.price)}`);
    }
  }
  return lines.join("\n");
}
