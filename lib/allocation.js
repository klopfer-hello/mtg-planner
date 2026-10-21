// Allocation of owned copies to decks, counted per oracle card across all
// printings.
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
//            "missing" (to_buy_count, shopping list, to_buy_eur)
// Basic lands never conflict and are never to buy or in use.
//
// Locked binders: copies lying in a locked binder (lib/deckboxes.js: the user's
// lock, else auto = deck boxes) belong to that binder. They are free only for the
// deck that owns it; for every other deck they count like copies another built
// deck claims (in_use, "🔒 in X · locked", can be moved), never free and never to
// buy. A built deck's claim takes from its own box first, so the lock and the
// claim never reserve the same copies twice. Conflicts stay about built decks'
// claims only (a lock never makes one); basics stay always free. Deck fields:
// in_locked, in_use_locked, in_use_locked_count (lib/decks.js).

import { nameArgs, nameMatch } from "./db.js";
import { lockedBinders } from "./deckboxes.js";
import { BOARD_ORDER_SQL, cardKey, isBasicLand } from "./deckrules.js";

/**
 * Rows of one card: `select` (a query over collection col JOIN cards c, up to its WHERE) by oracle
 * id (indexed), else (unresolved deck rows) by name (nameMatch); one OR'ed WHERE made SQLite scan the
 * whole collection per card. `tail` follows the WHERE (GROUP BY / ORDER BY). Returns {all(oracleId, name)}.
 */
export function byOracleOrName(db, select, tail = "") {
  const oracle = db.prepare(`${select} WHERE c.oracle_id = ? ${tail}`);
  const named = db.prepare(`${select} WHERE ${nameMatch()} ${tail}`);
  return { all: (oracleId, name) => (oracleId != null ? oracle.all(oracleId) : named.all(...nameArgs(name))) };
}

/**
 * Snapshot of ownership, built-deck claims and deck-box reservations: {ownedOf(key, name),
 * built: Map key -> {name, oracle_id, demand, decks:[{deck_id, name, status, quantity}]},
 * boxes (lib/deckboxes.js lockedBinders), boxCopiesOf(key, name) -> [{binder, owners, quantity}],
 * reserve(key, name, viewerId = null) -> {decks (other built decks' claims), boxes:[{binder,
 * deck_id, deck_name, quantity}] (box copies reserved against the viewer, after the owning
 * built deck's claim took its share), elsewhere (sum of both)}, boxReserveByOracle() -> Map
 * oracle_id -> box copies reserved on top of the built claims (viewer = nobody)}. Compute it
 * once and pass it to deckDetail/cardUsage when handling several decks.
 */
export function allocation(db) {
  // One key per card: an unresolved deck row ("name:sol ring", saved while Scryfall was down) is the
  // same card as a resolved one when the app knows that name, so both claim under its oracle id.
  // Every lookup below canonicalises its key, so callers may pass cardKey() of either kind.
  const oracleByName = db.prepare(`SELECT c.oracle_id FROM cards c WHERE ${nameMatch()} AND c.oracle_id IS NOT NULL LIMIT 1`);
  const canonical = new Map();
  const canon = (key) => {
    if (!String(key).startsWith("name:")) return key;
    if (!canonical.has(key)) canonical.set(key, oracleByName.get(...nameArgs(key.slice(5)))?.oracle_id ?? key);
    return canonical.get(key);
  };
  const owned = new Map();
  for (const r of db.prepare(
    `SELECT c.oracle_id, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id IS NOT NULL GROUP BY c.oracle_id`,
  ).all()) owned.set(r.oracle_id, r.q);
  const byName = db.prepare(
    `SELECT COALESCE(SUM(col.quantity), 0) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE ${nameMatch()}`,
  );
  const ownedOf = (rawKey, name) => {
    const key = canon(rawKey);
    if (owned.has(key)) return owned.get(key);
    if (!key.startsWith("name:")) return 0;
    const q = byName.get(...nameArgs(name)).q;
    owned.set(key, q);
    return q;
  };
  const built = new (class extends Map { get(k) { return super.get(canon(k)); } has(k) { return super.has(canon(k)); } })();
  const rows = db.prepare(
    `SELECT d.id AS deck_id, d.name AS deck_name, d.status, c.oracle_id, MIN(dc.name) AS card_name, SUM(dc.quantity) AS q
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE d.status = 'built' AND dc.board IN ('commander', 'main', 'side')
      GROUP BY d.id, COALESCE(c.oracle_id, 'name:' || lower(dc.name))
      ORDER BY d.name COLLATE NOCASE, d.id`,
  ).all();
  for (const r of rows) {
    const key = canon(cardKey(r.oracle_id, r.card_name));
    const e = built.get(key) ?? { name: r.card_name, oracle_id: key.startsWith("name:") ? null : key, demand: 0, decks: [] };
    e.demand += r.q;
    // One deck can hold the card twice (a resolved and an unresolved row): one claim.
    const mine = e.decks.find((d) => d.deck_id === r.deck_id);
    if (mine) mine.quantity += r.q;
    else e.decks.push({ deck_id: r.deck_id, name: r.deck_name, status: r.status, quantity: r.q });
    built.set(key, e);
  }
  // Copies per locked binder and card.
  const boxes = lockedBinders(db);
  const boxKeys = JSON.stringify([...boxes.keys()]);
  const boxCopies = new Map();
  if (boxes.size) {
    for (const r of db.prepare(
      `SELECT c.oracle_id, lower(col.binder) AS k, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
        WHERE c.oracle_id IS NOT NULL AND lower(col.binder) IN (SELECT value FROM json_each(?))
        GROUP BY c.oracle_id, lower(col.binder) ORDER BY lower(col.binder)`,
    ).all(boxKeys)) {
      const b = boxes.get(r.k);
      if (!boxCopies.has(r.oracle_id)) boxCopies.set(r.oracle_id, []);
      boxCopies.get(r.oracle_id).push({ binder: b.name, owners: b.owners, quantity: r.q });
    }
  }
  const boxByName = boxes.size ? db.prepare(
    `SELECT lower(col.binder) AS k, SUM(col.quantity) AS q FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE ${nameMatch()} AND lower(col.binder) IN (SELECT value FROM json_each(?))
      GROUP BY lower(col.binder) ORDER BY lower(col.binder)`,
  ) : null;
  const boxCopiesOf = (rawKey, name) => {
    const key = canon(rawKey);
    if (boxCopies.has(key)) return boxCopies.get(key);
    if (!key.startsWith("name:") || !boxByName) return [];
    const list = boxByName.all(...nameArgs(name), boxKeys).map((r) => ({ binder: boxes.get(r.k).name, owners: boxes.get(r.k).owners, quantity: r.q }));
    boxCopies.set(key, list);
    return list;
  };
  const reserve = (rawKey, name, viewer = null) => {
    const key = canon(rawKey);
    const claims = built.get(key)?.decks ?? [];
    const decks = viewer == null ? claims : claims.filter((d) => d.deck_id !== viewer);
    // A built deck's claim is met from its own box first: those copies are reserved once.
    const absorb = new Map(claims.map((d) => [d.deck_id, d.quantity]));
    const held = [];
    for (const e of boxCopiesOf(key, name)) {
      if (viewer != null && e.owners.some((o) => o.id === viewer)) continue;
      let q = e.quantity;
      for (const o of e.owners) {
        const a = absorb.get(o.id) ?? 0;
        const t = Math.min(a, q);
        if (t) { absorb.set(o.id, a - t); q -= t; }
      }
      if (q > 0) held.push({ binder: e.binder, deck_id: e.owners[0]?.id ?? null, deck_name: e.owners[0]?.name ?? null, quantity: q });
    }
    const elsewhere = decks.reduce((a, d) => a + d.quantity, 0) + held.reduce((a, b) => a + b.quantity, 0);
    return { decks, boxes: held, elsewhere };
  };
  const boxReserveByOracle = () => {
    const out = new Map();
    for (const key of boxCopies.keys()) {
      if (String(key).startsWith("name:")) continue;
      const n = reserve(key, null).boxes.reduce((a, b) => a + b.quantity, 0);
      if (n) out.set(key, n);
    }
    return out;
  };
  return { ownedOf, built, boxes, boxCopiesOf, reserve, boxReserveByOracle };
}

/**
 * Usage of one card: {owned, built_demand, in_boxes:[{binder, deck_id, deck_name, quantity}],
 * boxed (copies kept in locked binders on top of the built claims), available (owned minus
 * both; basics: owned), decks:[{id, name, status, board, quantity}]}
 * (decks = every deck holding the card, any status and board).
 */
export function cardUsage(db, { oracle_id: oracleId = null, name = "" } = {}, alloc = allocation(db)) {
  const key = cardKey(oracleId, name);
  const owned = alloc.ownedOf(key, name);
  const demand = alloc.built.get(key)?.demand ?? 0;
  const inBoxes = alloc.reserve(key, name).boxes;
  const boxed = inBoxes.reduce((a, b) => a + b.quantity, 0);
  const decks = db.prepare(
    `SELECT d.id, d.name, d.status, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (c.oracle_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board
      ORDER BY CASE d.status WHEN 'built' THEN 0 ELSE 1 END, d.name COLLATE NOCASE, d.id,
               ${BOARD_ORDER_SQL}`,
  ).all(oracleId, name);
  // Basic lands never conflict: every owned basic counts as free.
  const basic = isBasicLand(name || alloc.built.get(key)?.name);
  return { owned, built_demand: demand, in_boxes: inBoxes, boxed, available: basic ? owned : owned - demand - boxed, basic, decks };
}
