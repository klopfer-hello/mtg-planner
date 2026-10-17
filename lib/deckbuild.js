// Build checklist: the deck's cards grouped by where the user picks them up.
//
// Building a deck from the collection means walking from binder to binder. The
// checklist lists every card the deck needs (commander+main+side, never maybe)
// in the binder its free copies lie in, using the same take order as "Put into
// deck box" (lib/binders.js deckToBinder: previous box, Unsorted, plain
// binders, other deck boxes; never another built deck's binder):
//   binder groups  free copies, per binder ('' = Unsorted)
//   other          owned copies only another built deck's binder holds (or, for an
//                  idea deck, copies other built decks claim): "In other decks"
//   basics         basic lands the collection doesn't have enough of
//   buy            copies not owned at all ("To buy")
//   box            copies already in this deck's box / ManaBox binder (always done)
// Ticks are stored per (deck, card key, source) in deck_build_picks (v10), so they
// follow the user across devices. A tick never moves anything; the move is the
// separate "Put into deck box" (optionally only for the picked cards). When the
// deck or the collection changes, a pick counts only while its line still exists
// (clamped to the line's copies); writes prune the stale ones.

import { CLAIM_BOARDS, cardKey, deckDetail, eurOfPrinting } from "./decks.js";
import { bySourceOrder, deckBoxContext } from "./binders.js";

export class BuildError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const GROUP_ORDER = { binder: 0, other: 1, basics: 2, buy: 3, box: 4 };

/**
 * The checklist of a deck: {deck_id, name, status, box_binder (the "Put into deck box" target),
 * total, picked, complete, movable_picked (picked copies "Put into deck box" can move), groups:[{key,
 * kind binder|other|basics|buy|box, title, binder?, quantity, picked, lines:[{key, source, name,
 * quantity, picked, oracle_id, scryfall_id, image_small, type_line, mana_cost, commander, binder?,
 * decks?, price_eur?}]}]}.
 */
export function buildChecklist(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) throw new BuildError(404, "Deck not found");
  const { target, protectedBinders, isOwn, rank } = deckBoxContext(db, deck);
  const detail = deckDetail(db, deck.id, { power: false });
  const built = deck.status === "built";

  const needs = new Map();
  for (const c of detail.cards) {
    if (!CLAIM_BOARDS.includes(c.board)) continue;
    const key = cardKey(c.oracle_id, c.name);
    const e = needs.get(key) ?? {
      key, name: c.name, oracle_id: c.oracle_id ?? null, scryfall_id: c.scryfall_id ?? null, image_small: c.image_small ?? null,
      type_line: c.type_line ?? null, mana_cost: c.mana_cost ?? null, cmc: c.cmc ?? null, need: 0, commander: false,
      available: c.available_for_this, basic: c.basic, price_eur: eurOfPrinting(c.prices),
      decks: c.used_elsewhere.map((d) => d.name),
    };
    e.need += c.quantity;
    e.commander ||= c.board === "commander";
    needs.set(key, e);
  }
  const rowsByOracle = db.prepare(
    `SELECT col.* FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE c.oracle_id = ?`,
  );
  const rowsByName = db.prepare(
    `SELECT col.* FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.name = ? COLLATE NOCASE OR c.name LIKE ? || ' // %' COLLATE NOCASE`,
  );
  const picks = new Map(db.prepare("SELECT card_key, source, quantity FROM deck_build_picks WHERE deck_id = ?")
    .all(deck.id).map((p) => [`${p.card_key}\u0000${p.source}`, p.quantity]));

  const groups = new Map();
  const group = (key, kind, title, extra = {}) => {
    if (!groups.has(key)) groups.set(key, { key, kind, title, ...extra, quantity: 0, picked: 0, lines: [], _rank: extra._rank ?? 0 });
    return groups.get(key);
  };
  const addLine = (g, e, source, quantity, extra = {}) => {
    if (quantity <= 0) return;
    const done = g.kind === "box";
    const picked = done ? quantity : Math.min(quantity, picks.get(`${e.key}\u0000${source}`) ?? 0);
    g.lines.push({
      key: e.key, source, name: e.name, quantity, picked, oracle_id: e.oracle_id, scryfall_id: e.scryfall_id,
      image_small: e.image_small, type_line: e.type_line, mana_cost: e.mana_cost, commander: e.commander, ...extra,
    });
    g.quantity += quantity;
    g.picked += picked;
  };

  for (const e of needs.values()) {
    const rows = (e.oracle_id ? rowsByOracle.all(e.oracle_id) : rowsByName.all(e.name, e.name))
      .sort((a, b) => rank(a) - rank(b) || bySourceOrder(a, b));
    const boxed = Math.min(e.need, rows.filter(isOwn).reduce((a, r) => a + r.quantity, 0));
    addLine(group("box", "box", `Already in ${target}`, { binder: target }), e, "box", boxed);
    // Same cap as deckToBinder: an idea deck takes only the copies that are free for it.
    const cap = e.basic || built ? e.need : Math.min(e.need, Math.max(0, e.available));
    let left = Math.max(0, cap - boxed);
    const taken = new Map(); // row id -> copies used
    const perBinder = new Map();
    for (const r of rows) {
      if (!left) break;
      if (isOwn(r) || protectedBinders.has(r.binder.toLowerCase())) continue;
      const n = Math.min(left, r.quantity);
      taken.set(r.id, n);
      const k = r.binder.toLowerCase();
      const b = perBinder.get(k) ?? { binder: r.binder, quantity: 0, rank: rank(r) };
      b.quantity += n;
      perBinder.set(k, b);
      left -= n;
    }
    for (const [k, b] of perBinder) {
      addLine(group(`b:${k}`, "binder", b.binder || "Unsorted", { binder: b.binder, _rank: b.rank }), e, `b:${k}`, b.quantity);
    }
    const got = [...perBinder.values()].reduce((x, b) => x + b.quantity, 0);
    let rest = e.need - boxed - got;
    // Owned copies the deck can't take freely: another built deck's binder, or claimed elsewhere.
    if (rest > 0) {
      const other = new Map();
      const leftover = rows.filter((r) => !isOwn(r)).map((r) => ({ r, n: r.quantity - (taken.get(r.id) ?? 0) })).filter((x) => x.n > 0)
        .sort((a, b) => Number(!protectedBinders.has(a.r.binder.toLowerCase())) - Number(!protectedBinders.has(b.r.binder.toLowerCase())));
      for (const { r, n: avail } of leftover) {
        if (!rest) break;
        const n = Math.min(rest, avail);
        const k = r.binder.toLowerCase();
        const o = other.get(k) ?? { binder: r.binder, quantity: 0, deck: protectedBinders.get(k) ?? null };
        o.quantity += n;
        other.set(k, o);
        rest -= n;
      }
      for (const [k, o] of other) {
        const decks = o.deck ? [o.deck] : e.decks;
        addLine(group("other", "other", "In other decks"), e, `other:${k}`, o.quantity, { binder: o.binder, decks });
      }
    }
    if (rest > 0) {
      if (e.basic) addLine(group("basics", "basics", "Basic lands"), e, "basics", rest);
      else addLine(group("buy", "buy", "To buy"), e, "buy", rest, { price_eur: e.price_eur });
    }
  }

  const list = [...groups.values()].filter((g) => g.lines.length);
  list.sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || a._rank - b._rank
    || (a.binder ?? "").localeCompare(b.binder ?? "", undefined, { sensitivity: "base" }));
  for (const g of list) {
    delete g._rank;
    g.lines.sort((a, b) => Number(b.commander) - Number(a.commander) || a.name.localeCompare(b.name));
  }
  const total = list.reduce((a, g) => a + g.quantity, 0);
  const picked = list.reduce((a, g) => a + g.picked, 0);
  const movablePicked = list.filter((g) => g.kind === "binder").reduce((a, g) => a + g.picked, 0);
  return {
    deck_id: deck.id, name: deck.name, status: deck.status, box_binder: target,
    total, picked, complete: total > 0 && picked >= total, movable_picked: movablePicked, groups: list,
  };
}

/** Lines of a checklist by `${key}\0${source}`. */
const linesOf = (list) => new Map(list.groups.flatMap((g) => g.lines.map((l) => [`${l.key}\u0000${l.source}`, l])));

/** Delete picks whose line no longer exists (card left the deck, copies moved). */
function prunePicks(db, deckId, list) {
  const lines = linesOf(list);
  const del = db.prepare("DELETE FROM deck_build_picks WHERE deck_id = ? AND card_key = ? AND source = ?");
  for (const p of db.prepare("SELECT card_key, source FROM deck_build_picks WHERE deck_id = ?").all(deckId)) {
    const l = lines.get(`${p.card_key}\u0000${p.source}`);
    if (!l || l.source === "box") del.run(deckId, p.card_key, p.source);
  }
}

/**
 * Tick (quantity = the line's copies, or fewer) or untick (0) one checklist line {key, source, quantity}.
 * 404 when the line is not on the list any more, 400 for a box line (always done) or a bad quantity.
 * Returns the new checklist.
 */
export function setBuildPick(db, deckId, { key, source, quantity } = {}) {
  if (typeof key !== "string" || !key || key.length > 400) throw new BuildError(400, "key is required");
  if (typeof source !== "string" || !source || source.length > 250) throw new BuildError(400, "source is required");
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) throw new BuildError(400, "quantity must be an integer 0-999");
  const list = buildChecklist(db, deckId);
  const line = linesOf(list).get(`${key}\u0000${source}`);
  if (!line) throw new BuildError(404, "This card is not on the build list any more; reload");
  if (source === "box") throw new BuildError(400, "Cards already in the deck box are always picked");
  const n = Math.min(quantity, line.quantity);
  if (n === 0) db.prepare("DELETE FROM deck_build_picks WHERE deck_id = ? AND card_key = ? AND source = ?").run(list.deck_id, key, source);
  else {
    db.prepare(
      `INSERT INTO deck_build_picks (deck_id, card_key, source, quantity, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (deck_id, card_key, source) DO UPDATE SET quantity = excluded.quantity, at = excluded.at`,
    ).run(list.deck_id, key, source, n, new Date().toISOString());
  }
  prunePicks(db, list.deck_id, list);
  // The answer is the same list with this line's ticks changed (no second pass over the deck).
  const d = n - line.picked;
  line.picked = n;
  const g = list.groups.find((x) => x.lines.includes(line));
  g.picked += d;
  list.picked += d;
  if (g.kind === "binder") list.movable_picked += d;
  list.complete = list.total > 0 && list.picked >= list.total;
  return list;
}

/** Untick every line of a deck's checklist. Returns the new checklist. */
export function clearBuildPicks(db, deckId) {
  if (!db.prepare("SELECT 1 FROM decks WHERE id = ?").get(Number(deckId))) throw new BuildError(404, "Deck not found");
  db.prepare("DELETE FROM deck_build_picks WHERE deck_id = ?").run(Number(deckId));
  return buildChecklist(db, deckId);
}

/** Card keys with a picked copy in a binder group: what "Put into deck box" moves when only the picked cards go. */
export function pickedKeys(db, deckId) {
  const list = buildChecklist(db, deckId);
  return [...new Set(list.groups.filter((g) => g.kind === "binder").flatMap((g) => g.lines.filter((l) => l.picked > 0).map((l) => l.key)))];
}
