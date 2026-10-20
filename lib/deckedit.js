// Deck edits: status, notes, one card row (quantity, board), adding cards,
// bulk remove/move and setting the commander. Every edit runs in one
// transaction and records one deck history version (lib/deckhistory.js).

import { transaction, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { recordDeckVersion } from "./deckhistory.js";
import { BOARD_ORDER_SQL, BOARDS, canPair, DECK_STATUSES, DeckError, isCommanderFormat } from "./deckrules.js";
import { resolveDeckItems } from "./deckresolve.js";

/** The deck row, or DeckError 404. */
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

/** Set a deck's status ('idea' | 'built'), recorded in the deck history. Returns the deck row. */
export function setDeckStatus(db, deckId, status, { actor = "app" } = {}) {
  if (!DECK_STATUSES.includes(status)) throw new DeckError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const deck = requireDeck(db, deckId);
  db.prepare("UPDATE decks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, deck.id);
  recordDeckVersion(db, deck.id, { actor });
  return db.prepare("SELECT * FROM decks WHERE id = ?").get(deck.id);
}

/** Longest deck notes (decks.description, Markdown) the app and Claude may store. */
export const DECK_NOTES_MAX = 5000;

/**
 * Replace a deck's notes (decks.description, Markdown; '' clears them) and record a history version
 * (equal text = no version). Returns the stored text (null = none). DeckError 404 / 400 (too long).
 */
export function setDeckNotes(db, deckId, text, { actor = "app" } = {}) {
  if (text != null && typeof text !== "string") throw new DeckError(400, "notes must be text");
  const notes = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (notes.length > DECK_NOTES_MAX) throw new DeckError(400, `notes are too long (${notes.length} > ${DECK_NOTES_MAX} characters)`);
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    const value = notes || null;
    if ((deck.description ?? null) === value) return value;
    db.prepare("UPDATE decks SET description = ?, updated_at = datetime('now') WHERE id = ?").run(value, deck.id);
    recordDeckVersion(db, deck.id, { actor });
    return value;
  });
}

/**
 * Change one card row of a deck: {name, board, to_board?, quantity?}.
 * Without to_board, quantity sets the row's copies (0 removes the row).
 * With to_board, `quantity` copies (default all) move there, merging into a
 * row of the same name. Recorded in the deck history (actor, default app).
 * Returns {deck_id, name, board, to_board, moved?, quantity?}.
 */
export function updateDeckCard(db, deckId, { name, board, to_board: toBoard, quantity, actor = "app" } = {}) {
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
    recordDeckVersion(db, deck.id, { actor });
    return result;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Add copies of one card to a deck board, merging into an existing row of that name. The printing comes
 * from `scryfall_id` (the cards table, else Scryfall /cards/collection) or from `name` (an owned printing
 * first, else Scryfall, like a pasted decklist). One history version. Returns {deck_id, name, board,
 * scryfall_id, added}. DeckError 404 (deck or card not found) / 400 (bad board, quantity or id).
 */
export async function addDeckCard(db, deckId, { scryfall_id: id = null, name = null, board = "main", quantity = 1, actor = "app" } = {}) {
  requireDeck(db, deckId);
  if (!BOARDS.includes(board)) throw new DeckError(400, `board must be one of ${BOARDS.join(", ")}`);
  const n = validQuantity(quantity, { min: 1 });
  let row;
  if (id != null) {
    if (typeof id !== "string" || !UUID_RE.test(id)) throw new DeckError(400, "scryfall_id must be a Scryfall card id");
    let card = db.prepare("SELECT scryfall_id, name FROM cards WHERE scryfall_id = ?").get(id.toLowerCase());
    if (!card) {
      const { cards } = await fetchCollection([{ id: id.toLowerCase() }]);
      if (cards.length) upsertCards(db, cards.map(normalizeCard));
      card = db.prepare("SELECT scryfall_id, name FROM cards WHERE scryfall_id = ?").get(id.toLowerCase());
    }
    if (!card) throw new DeckError(404, "Card not found on Scryfall");
    row = { name: card.name, scryfall_id: card.scryfall_id };
  } else {
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "scryfall_id or name is required");
    const { rows, unresolved } = await resolveDeckItems(db, [{ name: name.trim(), quantity: n, board }]);
    if (unresolved.length || !rows[0]?.scryfall_id) throw new DeckError(404, `No card named "${name.trim()}" found`);
    row = { name: rows[0].name, scryfall_id: rows[0].scryfall_id };
  }
  return transaction(db, () => {
    const deck = requireDeck(db, deckId); // again: the Scryfall await may have outlived the deck
    addToBoard(db, deck.id, board, row, n);
    touch(db, deck.id);
    recordDeckVersion(db, deck.id, { actor });
    return { deck_id: deck.id, name: row.name, board, scryfall_id: row.scryfall_id, added: n };
  });
}

export const BULK_DECK_ACTIONS = ["remove", "move"];

/**
 * Remove several rows of a deck, or move them to another board, in one transaction and ONE history
 * version. items [{name, board}] (1-500); a row that isn't there → DeckError 404 and nothing changes.
 * Returns {deck_id, action, rows, copies, to_board}.
 */
export function bulkDeckCards(db, deckId, { items, action, to_board: toBoard = null, actor = "app" } = {}) {
  if (!BULK_DECK_ACTIONS.includes(action)) throw new DeckError(400, `action must be ${BULK_DECK_ACTIONS.join(" or ")}`);
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw new DeckError(400, "items must list 1-500 cards");
  if (action === "move" && !BOARDS.includes(toBoard)) throw new DeckError(400, `to_board must be one of ${BOARDS.join(", ")}`);
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    const seen = new Set();
    let rows = 0;
    let copies = 0;
    for (const item of items) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name || !BOARDS.includes(item?.board)) throw new DeckError(400, "every item needs a name and a board");
      const key = `${item.board}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = db.prepare("SELECT * FROM deck_cards WHERE deck_id = ? AND board = ? AND name = ? COLLATE NOCASE").get(deck.id, item.board, name);
      if (!row) throw new DeckError(404, `"${name}" is not in the ${item.board} board`);
      if (action === "move" && row.board === toBoard) continue;
      takeFromBoard(db, deck.id, row, row.quantity);
      if (action === "move") addToBoard(db, deck.id, toBoard, row, row.quantity);
      rows++;
      copies += row.quantity;
    }
    if (rows) {
      touch(db, deck.id);
      recordDeckVersion(db, deck.id, { actor });
    }
    return { deck_id: deck.id, action, rows, copies, to_board: action === "move" ? toBoard : null };
  });
}

/**
 * Make `name` (a card already in the deck, any board) the commander: one copy
 * moves into the commander board. Format commander allows two commanders when
 * they can pair (partner, friends forever, background, doctor's companion);
 * otherwise the existing commander(s) move back to main. `replace` (a
 * commander's name) swaps out that one specifically. Recorded in the deck history.
 * Returns {deck_id, commanders: [names], replaced: [names]}.
 */
export function setCommander(db, deckId, { name, replace = null, actor = "app" } = {}) {
  return transaction(db, () => {
    const deck = requireDeck(db, deckId);
    if (typeof name !== "string" || !name.trim()) throw new DeckError(400, "name is required");
    const card = (n) => db.prepare(
      `SELECT dc.*, c.type_line, c.oracle_text, c.keywords FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
        WHERE dc.deck_id = ? AND dc.name = ? COLLATE NOCASE
        ORDER BY ${BOARD_ORDER_SQL}`,
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
      recordDeckVersion(db, deck.id, { actor });
    }
    return { deck_id: deck.id, commanders: commanders().map((c) => c.name), replaced };
  });
}
