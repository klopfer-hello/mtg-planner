// Card names of a decklist → printings: name-only lines take a printing the
// user owns (unless preferOwned is off), everything else is looked up on
// Scryfall (/cards/collection, upserted into the cards table).

import { nameArgs, nameMatch, upsertCards } from "./db.js";
import { fetchCollection, normalizeCard } from "./scryfall.js";
import { BOARDS } from "./deckrules.js";

function ownedPrintingByName(db, name) {
  return db.prepare(
    `SELECT c.scryfall_id, c.name FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE ${nameMatch()}
      GROUP BY c.scryfall_id ORDER BY SUM(col.quantity) DESC LIMIT 1`,
  ).get(...nameArgs(name));
}

// A list line's foil/etched marker travels with its resolved row (collection list import).
const finishOf = (item) => (item.finish ? { finish: item.finish } : {});

// A companion is a side-board row; on any other board the flag is dropped.
const companionOf = (item, board) => (item.companion && board === "side" ? { companion: true } : {});

/**
 * Resolve {name, quantity, board, set?, collector_number?, companion?} items to deck rows.
 * Name-only items prefer a printing the user owns; everything else is looked
 * up on Scryfall. Returns { rows, unresolved }.
 */
export async function resolveDeckItems(db, items, { preferOwned = true } = {}) {
  const rows = [];
  const lookups = [];
  for (const item of items) {
    const board = BOARDS.includes(item.board) ? item.board : "main";
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    if (!item.set && preferOwned) {
      const owned = ownedPrintingByName(db, item.name);
      if (owned) { rows.push({ name: owned.name, scryfall_id: owned.scryfall_id, quantity, board, ...companionOf(item, board), ...finishOf(item) }); continue; }
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
      const extra = companionOf(item, item.board);
      if (card) rows.push({ name: card.name, scryfall_id: card.id, quantity: item.quantity, board: item.board, ...extra, ...finishOf(item) });
      else { unresolved.push(item.name); rows.push({ name: item.name, scryfall_id: null, quantity: item.quantity, board: item.board, ...extra }); }
    }
  }
  return { rows, unresolved };
}
