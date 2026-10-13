// Decks: decklist parsing, name → printing resolution (owned printings first),
// persistence, and ownership coverage against the collection.

import { cardPrice, formatPrice, transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";

export const BOARDS = ["commander", "main", "side", "maybe"];
const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);

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
export function saveDeckRows(db, { id, name, format = null, description = null, source = "manual", rows, matchByName = false, append = false }) {
  format = normalizeFormat(format);
  let deckId = id;
  if (!deckId && matchByName) {
    deckId = db.prepare("SELECT id FROM decks WHERE name = ? AND source = ?").get(name, source)?.id;
  }
  if (deckId) {
    const existing = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
    if (!existing) throw new Error(`Deck ${deckId} not found`);
    db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name ?? existing.name, format ?? existing.format, description ?? existing.description, deckId);
    if (!append) db.prepare("DELETE FROM deck_cards WHERE deck_id = ?").run(deckId);
  } else {
    deckId = Number(db.prepare("INSERT INTO decks (name, format, description, source) VALUES (?, ?, ?, ?)")
      .run(name, format, description, source).lastInsertRowid);
  }
  const insert = db.prepare(
    `INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (deck_id, board, name) DO UPDATE SET quantity = quantity + excluded.quantity`,
  );
  for (const r of rows) insert.run(deckId, r.board, r.name, r.scryfall_id, r.quantity);
  return deckId;
}

export async function saveDeck(db, { id, name, format, description, source, items, matchByName }) {
  const { rows, unresolved } = await resolveDeckItems(db, items);
  const deckId = transaction(db, () => saveDeckRows(db, { id, name, format, description, source, rows, matchByName }));
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

/** Decks, newest first, with card_count and value_eur (commander+main+side, EUR only). */
export function listDecks(db) {
  const decks = db.prepare(
    `SELECT d.*, COALESCE(SUM(dc.quantity), 0) AS card_count
       FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      GROUP BY d.id ORDER BY d.updated_at DESC`,
  ).all();
  for (const d of decks) d.value_eur = deckDetail(db, d.id)?.value.total_eur ?? 0;
  return decks;
}

const round2 = (v) => Math.round(v * 100) / 100;
const parsePrices = (p) => {
  if (!p) return {};
  if (typeof p !== "string") return p;
  try { return JSON.parse(p) || {}; } catch { return {}; }
};
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** EUR price of a printing for one finish exactly (eur / eur_foil / eur_etched), or null. Never USD. */
export function eurForFinish(prices, finish = "normal") {
  const p = parsePrices(prices);
  return num(p[finish === "foil" ? "eur_foil" : finish === "etched" ? "eur_etched" : "eur"]);
}

/** EUR price of a printing to buy: nonfoil eur, else (foil/etched-only printings) the foil/etched eur. Never USD. */
export function eurOfPrinting(prices) {
  const p = parsePrices(prices);
  return num(p.eur) ?? num(p.eur_foil) ?? num(p.eur_etched);
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
 */
export function deckDetail(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
  if (!deck) return null;
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
      WHERE c.oracle_id = ? OR (? IS NULL AND c.name = ? COLLATE NOCASE)
      ORDER BY col.id`,
  );
  let missingCount = 0;
  const neededByOracle = new Map();
  const ownedCopies = new Map(); // key -> [{eur|null}] expanded per copy (capped)
  const value = { total_eur: 0, owned_eur: 0, to_buy_eur: 0, maybe_eur: 0, no_eur_price: 0 };
  for (const card of cards) {
    const basic = BASIC_LANDS.has(card.name.toLowerCase());
    const key = card.oracle_id ?? card.name.toLowerCase();
    if (!ownedCopies.has(key)) {
      const copies = [];
      for (const r of ownedRowsStmt.all(card.oracle_id, card.oracle_id, card.name)) {
        const eur = eurForFinish(r.prices, r.finish);
        for (let i = 0; i < r.quantity && copies.length < 10000; i++) copies.push(eur);
      }
      ownedCopies.set(key, copies);
    }
    const copies = ownedCopies.get(key);
    const owned = copies.length;
    // The same card can sit in several boards; ownership is shared between them.
    const alreadyUsed = neededByOracle.get(key) ?? 0;
    neededByOracle.set(key, alreadyUsed + card.quantity);
    card.owned = owned;
    card.basic = basic;
    card.missing = basic ? 0 : Math.max(0, card.quantity - Math.max(0, owned - alreadyUsed));
    const price = card.prices ? cardPrice(card) : null;
    card.price = price;
    if (card.missing && card.board !== "maybe") missingCount += card.missing;

    // Value: owned copies at their own finish price, the rest at the deck printing's EUR price.
    const unitEur = eurOfPrinting(card.prices);
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
      value.no_eur_price += noPrice;
    }
  }
  value.owned_eur = round2(value.owned_eur);
  value.to_buy_eur = round2(value.to_buy_eur);
  value.maybe_eur = round2(value.maybe_eur);
  value.total_eur = round2(value.owned_eur + value.to_buy_eur);
  const count = (board) => cards.filter((c) => c.board === board).reduce((a, c) => a + c.quantity, 0);
  const detail = {
    ...deck,
    cards,
    counts: Object.fromEntries(BOARDS.map((b) => [b, count(b)])),
    missing_count: missingCount,
    missing_cost_eur: value.to_buy_eur,
    value,
  };
  if (isCommanderFormat(deck) && detail.counts.commander === 0) detail.commander_suggestions = commanderSuggestions(db, deckId);
  return detail;
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
  const lines = [`Deck #${detail.id} "${detail.name}"${detail.format ? ` [${detail.format}]` : ""} (source: ${detail.source})`];
  if (detail.description) lines.push(detail.description);
  lines.push(`Counts: ${BOARDS.map((b) => `${b} ${detail.counts[b]}`).join(", ")}. Missing from collection: ${detail.missing_count} cards (~€${detail.missing_cost_eur.toFixed(2)}).`);
  const v = detail.value;
  if (v) {
    lines.push(`Value: €${v.total_eur.toFixed(2)} (owned €${v.owned_eur.toFixed(2)}, to buy €${v.to_buy_eur.toFixed(2)}; maybeboard €${v.maybe_eur.toFixed(2)})`
      + (v.no_eur_price ? `; ${v.no_eur_price} cards have no EUR price.` : "."));
  }
  if (detail.commander_suggestions?.length) {
    lines.push(`No commander set. Possible commanders in the deck: ${detail.commander_suggestions.map((c) => c.name).join(", ")}.`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board);
    if (!cards.length) continue;
    lines.push(`\n## ${board}`);
    for (const c of cards) {
      const own = c.basic ? "basic" : c.missing ? `MISSING ${c.missing} (owned ${c.owned})` : `owned ${c.owned}`;
      lines.push(`${c.quantity}x ${c.name} | ${c.mana_cost || ""} | ${c.type_line || "?"} | ${own} | ${formatPrice(c.price)}`);
    }
  }
  return lines.join("\n");
}
