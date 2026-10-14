// The collection edit log's write side (table collection_edits, migration v8).
//
// Kept apart from lib/edits.js because lib/binders.js needs it too (a binder's
// "Delete cards" is logged and undoable like any other delete), and edits.js
// already imports binders.js. Undo and listing live in lib/edits.js.

export const KEY_COLS = ["scryfall_id", "finish", "language", "condition", "binder", "source"];
export const keyOf = (r) => Object.fromEntries(KEY_COLS.map((c) => [c, r[c]]));
export const keyStr = (k) => JSON.stringify(KEY_COLS.map((c) => k[c]));
export const ROW_BY_KEY = `SELECT * FROM collection WHERE scryfall_id = ? AND finish = ? AND language = ? AND condition = ? AND binder = ? AND source = ?`;
export const nowIso = () => new Date().toISOString();
const stateOf = (r) => (r ? { id: r.id, quantity: r.quantity, purchase_price: r.purchase_price ?? null, purchase_currency: r.purchase_currency ?? null } : null);

/**
 * Records the state of every row key an operation touches (before at the first
 * touch, after at the end) for the edit log. finish() drops keys that ended up
 * unchanged.
 */
export function tracker(db) {
  const get = db.prepare(ROW_BY_KEY);
  const touched = new Map();
  const read = (k) => get.get(...KEY_COLS.map((c) => k[c]));
  return {
    touch(k) {
      const s = keyStr(k);
      if (!touched.has(s)) touched.set(s, { key: keyOf(k), before: stateOf(read(k)) });
    },
    finish() {
      return [...touched.values()].map((t) => ({ ...t, after: stateOf(read(t.key)) }))
        .filter((t) => JSON.stringify(t.before) !== JSON.stringify(t.after));
    },
  };
}

/** Append one log entry; returns its id. kind edit|delete|relanguage, actor app|claude|maintenance. */
export function writeLog(db, { kind, actor, summary, copies, rows, scans = [], moves = [] }) {
  const changes = { rows };
  if (scans.length) changes.scans = scans;
  if (moves.length) changes.moves = moves;
  return Number(db.prepare("INSERT INTO collection_edits (at, kind, actor, summary, copies, changes) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nowIso(), kind, actor, summary, copies, JSON.stringify(changes)).lastInsertRowid);
}

/** "2× Sol Ring, 1× Bolt, +3 more" for a Map(name -> copies). */
export function copyList(names, max = 5) {
  const list = [...names].map(([name, n]) => `${n}× ${name}`);
  return `${list.slice(0, max).join(", ")}${list.length > max ? `, +${list.length - max} more` : ""}`;
}
