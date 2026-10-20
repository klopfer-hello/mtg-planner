// Add a text card list to the collection (Settings → Import → Card list, Decks → Import decklist → "I own
// these cards"): typically a preconstructed deck you bought. The same decklist format as deck imports
// ("1 Sol Ring", "(SET) 123" for an exact printing, "*F*" foil, "*E*" etched, Commander/Deck/Sideboard
// sections; the maybeboard is not owned). Name-only lines take Scryfall's current printing, never one you
// already own (these are new copies). New copies are source 'app' rows in one binder with the chosen
// language and condition; the whole import is ONE entry of the collection edit log (kind 'add'), so Recent
// changes can undo it. With `deck` it also creates the deck (status built) with the same printings and
// links the binder as its deck box.

import { ensureBinder, findBinder, BinderError } from "./binders.js";
import { parseDecklist, normalizeFormat } from "./deckrules.js";
import { resolveDeckItems } from "./deckresolve.js";
import { saveDeckRows } from "./decks.js";
import { recordDeckVersion } from "./deckhistory.js";
import { UPSERT_COPIES, transaction } from "./db.js";
import { EDIT_CONDITIONS } from "./edits.js";
import { copyList, tracker, writeLog } from "./editlog.js";

const OWNED_BOARDS = new Set(["commander", "main", "side"]);
const LANG_RE = /^[a-z]{2,3}$/;
export const LIST_MAX_LINES = 1000;

/**
 * Parse + resolve a list (async: unknown printings come from Scryfall). Returns {rows (owned boards,
 * resolved), deckRows (every board, for the deck), unresolved: [names], parse_errors: [lines]}.
 */
export async function resolveCardList(db, text) {
  const { items, errors } = parseDecklist(String(text ?? ""));
  if (items.length > LIST_MAX_LINES) throw new BinderError(400, `At most ${LIST_MAX_LINES} lines at once`);
  const { rows, unresolved } = await resolveDeckItems(db, items, { preferOwned: false });
  return { rows: rows.filter((r) => r.scryfall_id && OWNED_BOARDS.has(r.board)), deckRows: rows, unresolved, parse_errors: errors };
}

/**
 * Add the resolved list to the collection (and optionally create the deck). Synchronous: run it inside
 * the server's exclusive() after resolveCardList. options: binder ('' = Unsorted), create (binder may be
 * new), language ('en'), condition ('near_mint'), deck ({name, format?} or null). Returns {binder,
 * created, added_copies, cards, unresolved, parse_errors, edit_id, deck_id}.
 */
export function addCardList(db, resolved, { binder = "", create = true, language = "en", condition = "near_mint", deck = null, actor = "app" } = {}) {
  const { rows, deckRows, unresolved, parse_errors } = resolved;
  if (!rows.length) throw new BinderError(400, unresolved.length ? `No card of the list was found (e.g. "${unresolved[0]}")` : "The list has no cards");
  if (typeof binder !== "string") throw new BinderError(400, "binder must be a string");
  const lang = String(language || "en").toLowerCase();
  if (!LANG_RE.test(lang)) throw new BinderError(400, "language must be a language code like en or de");
  if (!EDIT_CONDITIONS.includes(condition)) throw new BinderError(400, `condition must be one of ${EDIT_CONDITIONS.join(", ")}`);
  const deckName = deck ? String(deck.name ?? "").trim() : "";
  if (deck && !deckName) throw new BinderError(400, "the deck needs a name");
  return transaction(db, () => {
    const name = binder.trim();
    const existing = name ? findBinder(db, name) : "";
    if (name && !existing && !create) throw new BinderError(404, `No binder named "${name}"`);
    const target = existing ?? name;
    const created = Boolean(name && !existing);
    if (target) ensureBinder(db, target, "app");
    const t = tracker(db);
    const upsert = db.prepare(UPSERT_COPIES);
    const names = new Map();
    let copies = 0;
    for (const r of rows) {
      const key = { scryfall_id: r.scryfall_id, finish: r.finish || "normal", language: lang, condition, binder: target, source: "app" };
      t.touch(key);
      upsert.run(key.scryfall_id, key.finish, key.language, key.condition, key.binder, r.quantity, null, null, "app");
      names.set(r.name, (names.get(r.name) ?? 0) + r.quantity);
      copies += r.quantity;
    }
    const summary = `Added ${copies} ${copies === 1 ? "copy" : "copies"} to ${target || "Unsorted"}: ${copyList(names)}`;
    const editId = writeLog(db, { kind: "add", actor, summary, copies, rows: t.finish() });
    let deckId = null;
    if (deck) {
      deckId = saveDeckRows(db, {
        name: deckName.slice(0, 200), format: deck.format ? normalizeFormat(String(deck.format)) : null, source: "manual", status: "built",
        rows: deckRows.map(({ finish: _f, ...r }) => r),
      });
      if (target) db.prepare("UPDATE decks SET box_binder = ? WHERE id = ?").run(target, deckId);
      recordDeckVersion(db, deckId, { actor });
    }
    return { binder: target, created, added_copies: copies, cards: names.size, unresolved, parse_errors, edit_id: editId, deck_id: deckId };
  });
}
