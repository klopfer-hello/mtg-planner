// Deck history: every deck change stores a version snapshot (deck_versions,
// migration v10), so the user can see what changed, who changed it (the app,
// Claude, a ManaBox import or a scan commit) and go back to an older version.
//
// A snapshot is the deck's rows (board, name, quantity, scryfall_id, companion)
// plus its meta (name, format, description, status, bracket_declared). The
// writers call recordDeckVersion AFTER their change, inside their transaction;
// a snapshot equal to the deck's newest version is not stored again, and only
// the newest DECK_VERSIONS_KEEP versions per deck are kept. Restoring writes the
// old rows (and name, format, description, bracket) back and records that as a
// NEW version: nothing is ever lost by a restore. The status (idea | built) is
// not restored: it decides which copies the deck claims (lib/allocation.js).
//
// No imports from db.js (db.js runs the v10 backfill with snapshotDeck).

import { createHash } from "node:crypto";
import { StatusError } from "./errors.js";

/** Versions kept per deck (oldest pruned first). */
export const DECK_VERSIONS_KEEP = 50;
/** Who made a change. */
export const DECK_ACTORS = ["app", "claude", "import", "scan", "system"];
const BOARD_ORDER = ["commander", "main", "side", "maybe"];
const META_FIELDS = ["name", "format", "description", "status", "bracket_declared"];

export class DeckHistoryError extends StatusError {}

/** The deck's current snapshot {meta, cards} (sorted, canonical), or null when the deck is gone. */
export function snapshotDeck(db, deckId) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
  if (!deck) return null;
  const meta = Object.fromEntries(META_FIELDS.map((f) => [f, deck[f] ?? null]));
  const cards = db.prepare(
    "SELECT board, name, quantity, scryfall_id, companion FROM deck_cards WHERE deck_id = ?",
  ).all(deck.id).map((r) => ({
    board: r.board, name: r.name, quantity: r.quantity, scryfall_id: r.scryfall_id ?? null, companion: r.companion ? 1 : 0,
  }));
  cards.sort((a, b) => boardRank(a.board) - boardRank(b.board) || cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.name, b.name));
  return { meta, cards };
}

const boardRank = (b) => { const i = BOARD_ORDER.indexOf(b); return i < 0 ? 9 : i; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hashOf = (snap) => createHash("sha256").update(JSON.stringify(snap)).digest("hex");
const cardCount = (cards) => cards.filter((c) => c.board !== "maybe").reduce((a, c) => a + c.quantity, 0);
const nowIso = () => new Date().toISOString();

/**
 * Differences from snapshot `a` to `b` (a may be null = empty deck):
 * {boards:[{board, added:[{name, quantity}], removed:[{name, quantity}], changed:[{name, from, to, printing?}]}],
 *  meta:[{field, from, to}], added, removed, moved} (added/removed = copies, moved = copies that only changed board).
 */
export function diffSnapshots(a, b) {
  const key = (c) => `${c.board}\u0000${c.name.toLowerCase()}`;
  const before = new Map((a?.cards ?? []).map((c) => [key(c), c]));
  const after = new Map((b?.cards ?? []).map((c) => [key(c), c]));
  const boards = new Map();
  const entry = (board) => {
    if (!boards.has(board)) boards.set(board, { board, added: [], removed: [], changed: [] });
    return boards.get(board);
  };
  // Per card name across boards, to tell a move (main -> commander) from add + remove.
  const plus = new Map(), minus = new Map();
  const bump = (m, name, n) => m.set(name.toLowerCase(), (m.get(name.toLowerCase()) ?? 0) + n);
  for (const [k, c] of after) {
    const old = before.get(k);
    if (!old) { entry(c.board).added.push({ name: c.name, quantity: c.quantity }); bump(plus, c.name, c.quantity); continue; }
    const printing = (old.scryfall_id ?? null) !== (c.scryfall_id ?? null);
    if (old.quantity !== c.quantity || printing) {
      entry(c.board).changed.push({ name: c.name, from: old.quantity, to: c.quantity, ...(printing ? { printing: true } : {}) });
      if (c.quantity > old.quantity) bump(plus, c.name, c.quantity - old.quantity);
      else if (c.quantity < old.quantity) bump(minus, c.name, old.quantity - c.quantity);
    }
  }
  for (const [k, c] of before) {
    if (after.has(k)) continue;
    entry(c.board).removed.push({ name: c.name, quantity: c.quantity });
    bump(minus, c.name, c.quantity);
  }
  let added = 0, removed = 0, moved = 0;
  for (const [n, p] of plus) { const m = Math.min(p, minus.get(n) ?? 0); moved += m; added += p - m; }
  for (const [n, q] of minus) removed += q - Math.min(q, plus.get(n) ?? 0);
  const meta = [];
  if (a) {
    for (const f of META_FIELDS) {
      if ((a.meta?.[f] ?? null) !== (b?.meta?.[f] ?? null)) meta.push({ field: f, from: a.meta?.[f] ?? null, to: b?.meta?.[f] ?? null });
    }
  }
  const out = [...boards.values()].sort((x, y) => boardRank(x.board) - boardRank(y.board));
  for (const e of out) for (const l of [e.added, e.removed, e.changed]) l.sort((x, y) => cmp(x.name.toLowerCase(), y.name.toLowerCase()));
  return { boards: out, meta, added, removed, moved };
}

/** Short text of a diff: "+2 −1 cards · 1 moved · status built". */
export function diffSummary(diff) {
  const parts = [];
  const cards = [diff.added ? `+${diff.added}` : "", diff.removed ? `−${diff.removed}` : ""].filter(Boolean).join(" ");
  if (cards) parts.push(`${cards} card${diff.added + diff.removed === 1 ? "" : "s"}`);
  if (diff.moved) parts.push(`${diff.moved} moved`);
  const printings = diff.boards.reduce((a, b) => a + b.changed.filter((c) => c.printing && c.from === c.to).length, 0);
  if (printings) parts.push(`${printings} printing${printings === 1 ? "" : "s"} changed`);
  for (const m of diff.meta) {
    if (m.field === "name") parts.push(`renamed to "${m.to}"`);
    else if (m.field === "status") parts.push(`status ${m.to}`);
    else if (m.field === "format") parts.push(m.to ? `format ${m.to}` : "format cleared");
    else if (m.field === "bracket_declared") parts.push(m.to == null ? "bracket auto" : `bracket ${m.to}`);
    else if (m.field === "description") parts.push("description changed");
  }
  return parts.join(" · ") || "No changes";
}

/**
 * Store the deck's current state as a new version (call after the change, inside its transaction).
 * Skipped when it equals the newest version. `summary` replaces the computed one (diff vs the newest
 * version, "Created · n cards" for a first one). Returns the new version id, or null when skipped.
 */
export function recordDeckVersion(db, deckId, { actor = "app", summary = null, restoredFrom = null, at = null } = {}) {
  const snap = snapshotDeck(db, deckId);
  if (!snap) return null;
  if (!DECK_ACTORS.includes(actor)) actor = "app";
  const hash = hashOf(snap);
  const prev = db.prepare("SELECT id, hash, meta, cards FROM deck_versions WHERE deck_id = ? ORDER BY id DESC LIMIT 1").get(Number(deckId));
  if (prev && prev.hash === hash) return null;
  const count = cardCount(snap.cards);
  let text = summary;
  if (!text) {
    text = prev ? diffSummary(diffSnapshots(parseVersion(prev), snap)) : `Created · ${count} card${count === 1 ? "" : "s"}`;
  }
  const id = Number(db.prepare(
    `INSERT INTO deck_versions (deck_id, at, actor, summary, hash, card_count, meta, cards, restored_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Number(deckId), at ?? nowIso(), actor, text.slice(0, 300), hash, count, JSON.stringify(snap.meta), JSON.stringify(snap.cards), restoredFrom).lastInsertRowid);
  db.prepare(
    `DELETE FROM deck_versions WHERE deck_id = ? AND id NOT IN
       (SELECT id FROM deck_versions WHERE deck_id = ? ORDER BY id DESC LIMIT ?)`,
  ).run(Number(deckId), Number(deckId), DECK_VERSIONS_KEEP);
  return id;
}

function parseVersion(row) {
  let meta = {}, cards = [];
  try { meta = JSON.parse(row.meta) ?? {}; } catch { meta = {}; }
  try { cards = JSON.parse(row.cards) ?? []; } catch { cards = []; }
  return { meta, cards: Array.isArray(cards) ? cards : [] };
}

/**
 * Versions of a deck, newest first: {deck_id, keep, versions:[{id, at, actor, summary, card_count, name,
 * restored_from, current}]} (current = equals the deck as it is now). 404 when the deck is gone.
 */
export function listDeckVersions(db, deckId) {
  const id = Number(deckId);
  const snap = snapshotDeck(db, id);
  if (!snap) throw new DeckHistoryError(404, "Deck not found");
  const hash = hashOf(snap);
  const rows = db.prepare(
    `SELECT id, at, actor, summary, card_count, hash, restored_from, json_extract(meta, '$.name') AS name
       FROM deck_versions WHERE deck_id = ? ORDER BY id DESC`,
  ).all(id);
  let currentSeen = false;
  const versions = rows.map((r) => {
    // Only the newest matching version is "current" (a restore can repeat an older state).
    const current = !currentSeen && r.hash === hash;
    if (current) currentSeen = true;
    return { id: r.id, at: r.at, actor: r.actor, summary: r.summary, card_count: r.card_count, name: r.name,
      restored_from: r.restored_from ?? null, current };
  });
  return { deck_id: id, keep: DECK_VERSIONS_KEEP, versions };
}

function versionRow(db, deckId, versionId) {
  const row = db.prepare("SELECT * FROM deck_versions WHERE deck_id = ? AND id = ?").get(Number(deckId), Number(versionId));
  if (!row) throw new DeckHistoryError(404, "Version not found");
  return row;
}

/**
 * One version: {version:{id, at, actor, summary, card_count, restored_from, meta, cards}, diff (vs the
 * version before it; null for the oldest kept), restore (diff from the deck now to this version = what a
 * restore would change; status changes are left out because a restore keeps the status)}.
 */
export function deckVersion(db, deckId, versionId) {
  const snapNow = snapshotDeck(db, deckId);
  if (!snapNow) throw new DeckHistoryError(404, "Deck not found");
  const row = versionRow(db, deckId, versionId);
  const v = parseVersion(row);
  const prevRow = db.prepare("SELECT * FROM deck_versions WHERE deck_id = ? AND id < ? ORDER BY id DESC LIMIT 1").get(Number(deckId), row.id);
  const restore = diffSnapshots(snapNow, { meta: { ...v.meta, status: snapNow.meta.status }, cards: v.cards });
  return {
    version: { id: row.id, at: row.at, actor: row.actor, summary: row.summary, card_count: row.card_count,
      restored_from: row.restored_from ?? null, meta: v.meta, cards: v.cards },
    diff: prevRow ? diffSnapshots(parseVersion(prevRow), v) : null,
    restore: { ...restore, summary: diffSummary(restore) },
  };
}

/**
 * Put an older version back: the deck's rows, name, format, description and bracket become the version's
 * (status stays). Recorded as a new version (actor, "Restored version from <at>"); version_id is null when
 * nothing changed. Card rows whose printing is no longer in the cards table keep their name without a
 * printing. Returns {version_id, restored_from}.
 */
export function restoreDeckVersion(db, deckId, versionId, { actor = "app" } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(Number(deckId));
    if (!deck) throw new DeckHistoryError(404, "Deck not found");
    const row = versionRow(db, deck.id, versionId);
    const v = parseVersion(row);
    const m = v.meta;
    db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, bracket_declared = ?, updated_at = datetime('now') WHERE id = ?")
      .run(typeof m.name === "string" && m.name.trim() ? m.name : deck.name, m.format ?? null, m.description ?? null,
        Number.isInteger(m.bracket_declared) ? m.bracket_declared : null, deck.id);
    db.prepare("DELETE FROM deck_cards WHERE deck_id = ?").run(deck.id);
    const known = db.prepare("SELECT 1 FROM cards WHERE scryfall_id = ?");
    const insert = db.prepare(
      `INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity, companion) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (deck_id, board, name) DO UPDATE SET quantity = quantity + excluded.quantity`,
    );
    for (const c of v.cards) {
      if (!c || typeof c.name !== "string" || !BOARD_ORDER.includes(c.board) || !(c.quantity > 0)) continue;
      const sid = c.scryfall_id && known.get(c.scryfall_id) ? c.scryfall_id : null;
      insert.run(deck.id, c.board, c.name, sid, Math.trunc(c.quantity), c.companion && c.board === "side" ? 1 : 0);
    }
    const when = row.at.replace("T", " ").slice(0, 16);
    const id = recordDeckVersion(db, deck.id, { actor, summary: `Restored version from ${when} UTC`, restoredFrom: row.id });
    db.exec("COMMIT");
    return { version_id: id, restored_from: row.id };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
