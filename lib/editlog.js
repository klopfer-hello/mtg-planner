// The collection edit log's write side (table collection_edits, migration v8).
//
// Kept apart from lib/edits.js because lib/binders.js needs it too (a binder's
// "Delete cards" is logged and undoable like any other delete), and edits.js
// already imports binders.js. Undo and listing live in lib/edits.js. The
// `moves` of edit/delete entries (which ManaBox line edited or deleted copies
// came from) are read by lib/manabox.js imports, so they live here too.

import { nowIso, parseJson } from "./db.js";

export const KEY_COLS = ["scryfall_id", "finish", "language", "condition", "binder", "source"];
export const keyOf = (r) => Object.fromEntries(KEY_COLS.map((c) => [c, r[c]]));
export const keyStr = (k) => JSON.stringify(KEY_COLS.map((c) => k[c]));
export const ROW_BY_KEY = `SELECT * FROM collection WHERE scryfall_id = ? AND finish = ? AND language = ? AND condition = ? AND binder = ? AND source = ?`;
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

/**
 * Append one log entry; returns its id. kind edit|delete|relanguage, actor app|claude|maintenance.
 * decks: [{id, box_binder}] whose deck box a binder delete cleared (undo sets them again).
 */
export function writeLog(db, { kind, actor, summary, copies, rows, scans = [], moves = [], decks = [] }) {
  const changes = { rows };
  if (scans.length) changes.scans = scans;
  if (moves.length) changes.moves = moves;
  if (decks.length) changes.decks = decks;
  return Number(db.prepare("INSERT INTO collection_edits (at, kind, actor, summary, copies, changes) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nowIso(), kind, actor, summary, copies, JSON.stringify(changes)).lastInsertRowid);
}

/** "2× Sol Ring, 1× Bolt, +3 more" for a Map(name -> copies). */
export function copyList(names, max = 5) {
  const list = [...names].map(([name, n]) => `${n}× ${name}`);
  return `${list.slice(0, max).join(", ")}${list.length > max ? `, +${list.length - max} more` : ""}`;
}

// ---------------------------------------------------------------------------
// ManaBox origin of edited / deleted copies ("moves"), read by lib/manabox.js imports

/** ManaBox line key without the binder: printing, finish, language, condition. */
export const printKey = (id, finish, language, condition) => [id, finish, language, condition].join("|");

/**
 * ManaBox-origin copies the user edited (to = printKey now) or deleted (to = null) in the app,
 * from the `moves` of not undone 'edit' and 'delete' entries:
 * [{edit_id, i, origin (printKey of the ManaBox line), to, n, netted, binder, at}], oldest first
 * (binder, at: deletes only, else null).
 * Imports use them to recognise the same change made in ManaBox (delta; replace via the
 * snapshot) or a file that still lists the old line (replace), so an edited copy is not
 * counted twice and a deleted one is not loaded again.
 */
export function editMoves(db) {
  const out = [];
  for (const e of db.prepare("SELECT id, changes FROM collection_edits WHERE kind IN ('edit', 'delete') AND undone_at IS NULL ORDER BY id").all()) {
    const moves = parseJson(e.changes, {}).moves ?? [];
    if (!Array.isArray(moves)) continue;
    moves.forEach((m, i) => {
      if (m && typeof m.origin === "string" && (typeof m.to === "string" || m.to === null) && m.n > 0) {
        out.push({ edit_id: e.id, i, origin: m.origin, to: m.to, n: m.n, netted: m.netted ?? 0,
          binder: typeof m.binder === "string" ? m.binder : null, at: typeof m.at === "string" ? m.at : null });
      }
    });
  }
  return out;
}

/** Add `add` to the netted count of move i of log entry `editId` (an import counted it). */
export function markNetted(db, editId, i, add) {
  const e = db.prepare("SELECT changes FROM collection_edits WHERE id = ?").get(editId);
  if (!e) return;
  const ch = JSON.parse(e.changes);
  ch.moves[i].netted = (ch.moves[i].netted ?? 0) + add;
  db.prepare("UPDATE collection_edits SET changes = ? WHERE id = ?").run(JSON.stringify(ch), editId);
}

/**
 * The ManaBox lines n copies of a manabox/app row came from, per copy: [{origin, n}]. App copies
 * that an earlier, not yet counted edit moved to the row's key still come from that edit's line,
 * newest edit first, but each edit move covers at most its own n - netted copies; the rest come
 * from the row's own key (as heldByLine counts them). `earlier` = editMoves(db) read before the
 * change; `used` (Map, shared by every pick of one operation) remembers what earlier picks of the
 * operation already took from each move, so two rows (or two picks) never both claim the same
 * edited copy. Scan rows have none ([]).
 */
export function originParts(row, n, earlier, used = new Map()) {
  if (row.source !== "manabox" && row.source !== "app") return [];
  const from = printKey(row.scryfall_id, row.finish, row.language, row.condition);
  const parts = [];
  let q = n;
  if (row.source === "app") {
    for (let i = earlier.length - 1; i >= 0 && q > 0; i--) {
      const m = earlier[i];
      if (m.to !== from) continue;
      const id = `${m.edit_id}:${m.i}`;
      const cap = m.n - m.netted - (used.get(id) ?? 0);
      if (cap <= 0) continue;
      const x = Math.min(q, cap);
      used.set(id, (used.get(id) ?? 0) + x);
      parts.push({ origin: m.origin, n: x });
      q -= x;
    }
  }
  if (q > 0) parts.push({ origin: from, n: q });
  return parts;
}

/**
 * The ManaBox line a delete move (to null) takes copies off: its origin, or `at` (the key the
 * deleted copies had after an edit) once an import counted that edit, i.e. ManaBox lists the
 * copy under the edited key now. `moves` = editMoves(db) (with any netting done so far).
 */
export function deleteLine(m, moves) {
  if (m.at && moves.some((e) => e.origin === m.origin && e.to === m.at && e.netted > 0)) return m.at;
  return m.origin;
}

/**
 * Copies per ManaBox line (printKey) the collection still holds as manabox/app rows: a manabox
 * row counts for its own line, app copies an open (not yet counted) edit moved to their key
 * count for that edit's origin, the rest of an app row for its own key. `moves` = editMoves(db).
 */
function heldByLine(db, moves) {
  const held = new Map();
  const add = (k, q) => held.set(k, (held.get(k) ?? 0) + q);
  for (const r of db.prepare(
    "SELECT source, scryfall_id, finish, language, condition, SUM(quantity) AS q FROM collection WHERE source IN ('manabox', 'app') GROUP BY 1, 2, 3, 4, 5",
  ).all()) {
    const pk = printKey(r.scryfall_id, r.finish, r.language, r.condition);
    let q = r.q;
    if (r.source === "app") {
      for (let i = moves.length - 1; i >= 0 && q > 0; i--) {
        const m = moves[i];
        if (m.to !== pk || m.n - m.netted <= 0) continue;
        const x = Math.min(q, m.n - m.netted);
        add(m.origin, x);
        q -= x;
      }
    }
    if (q > 0) add(pk, q);
  }
  return held;
}

/**
 * Moves for a delete of picks [{row, n}] (rows read before the delete): {origin, to: null, n,
 * netted: 0, binder, at?} per ManaBox line (binder = the ManaBox row's binder, null for app
 * rows; at = the row's own key when an earlier edit moved it there from origin), so a replace
 * import does not load the deleted copies again until ManaBox drops them too.
 * Only the part ManaBox actually lists is logged: per line at most the last export's copies
 * (manabox_snapshot) minus the copies still held after this delete minus the deletes already
 * open on it. A surplus copy (an `add` import's duplicate, an app copy ManaBox no longer lists)
 * is not backed by ManaBox, and logging it would make replace drop a genuine copy instead.
 */
export function deleteMoves(db, picks) {
  const earlier = editMoves(db);
  const snap = new Map(db.prepare(
    "SELECT scryfall_id, finish, language, condition, SUM(quantity) AS q FROM manabox_snapshot GROUP BY 1, 2, 3, 4",
  ).all().map((r) => [printKey(r.scryfall_id, r.finish, r.language, r.condition), r.q]));
  const held = heldByLine(db, earlier);
  const open = new Map();
  for (const m of earlier) {
    if (m.to !== null || m.n - m.netted <= 0) continue;
    const line = deleteLine(m, earlier);
    open.set(line, (open.get(line) ?? 0) + m.n - m.netted);
  }
  const used = new Map();
  const list = picks.flatMap(({ row, n }) => (n > 0 ? originParts(row, n, earlier, used) : []).map((p) => ({ row, n: p.n, origin: p.origin })));
  for (const p of list) held.set(p.origin, (held.get(p.origin) ?? 0) - p.n);
  const budget = new Map();
  const left = (origin) => {
    if (!budget.has(origin)) budget.set(origin, Math.max(0, (snap.get(origin) ?? 0) - Math.max(0, held.get(origin) ?? 0) - (open.get(origin) ?? 0)));
    return budget.get(origin);
  };
  const moves = [];
  // ManaBox rows first: they say which ManaBox binder the copies are in.
  for (const { row, n: want, origin } of [...list].sort((a, b) => (a.row.source === "manabox" ? 0 : 1) - (b.row.source === "manabox" ? 0 : 1))) {
    const n = Math.min(want, left(origin));
    if (n <= 0) continue;
    budget.set(origin, budget.get(origin) - n);
    const binder = row.source === "manabox" ? row.binder : null;
    const here = printKey(row.scryfall_id, row.finish, row.language, row.condition);
    const at = here === origin ? null : here;
    const m = moves.find((x) => x.origin === origin && x.binder === binder && (x.at ?? null) === at);
    if (m) m.n += n;
    else moves.push({ origin, to: null, n, netted: 0, binder, ...(at ? { at } : {}) });
  }
  return moves;
}
