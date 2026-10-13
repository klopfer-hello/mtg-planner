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

export function listDecks(db) {
  return db.prepare(
    `SELECT d.*, COALESCE(SUM(dc.quantity), 0) AS card_count
       FROM decks d LEFT JOIN deck_cards dc ON dc.deck_id = d.id
      GROUP BY d.id ORDER BY d.updated_at DESC`,
  ).all();
}

/** Deck with per-card ownership (counted across all printings of the card). */
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
  const ownedStmt = db.prepare(
    `SELECT COALESCE(SUM(col.quantity), 0) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ? OR (? IS NULL AND c.name = ? COLLATE NOCASE)`,
  );
  let missingCost = 0;
  let missingCount = 0;
  const neededByOracle = new Map();
  for (const card of cards) {
    const basic = BASIC_LANDS.has(card.name.toLowerCase());
    const key = card.oracle_id ?? card.name.toLowerCase();
    const owned = ownedStmt.get(card.oracle_id, card.oracle_id, card.name).q;
    // The same card can sit in several boards; ownership is shared between them.
    const alreadyUsed = neededByOracle.get(key) ?? 0;
    neededByOracle.set(key, alreadyUsed + card.quantity);
    card.owned = owned;
    card.basic = basic;
    card.missing = basic ? 0 : Math.max(0, card.quantity - Math.max(0, owned - alreadyUsed));
    const price = card.prices ? cardPrice(card) : null;
    card.price = price;
    if (card.missing && card.board !== "maybe") {
      missingCount += card.missing;
      if (price?.currency === "€") missingCost += price.value * card.missing;
    }
  }
  const count = (board) => cards.filter((c) => c.board === board).reduce((a, c) => a + c.quantity, 0);
  return {
    ...deck,
    cards,
    counts: Object.fromEntries(BOARDS.map((b) => [b, count(b)])),
    missing_count: missingCount,
    missing_cost_eur: Math.round(missingCost * 100) / 100,
  };
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
