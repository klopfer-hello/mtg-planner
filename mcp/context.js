// Shared state of the collection MCP server: the app DB and the optional card
// index (both opened on first use, so the handshake works without the data
// volume), the Commander Spellbook scheduler and the stderr logger. stdout
// carries protocol messages only.

import path from "node:path";
import { existsSync } from "node:fs";
import { openDb } from "../lib/db.js";
import { createSpellbookScheduler } from "../lib/spellbook.js";
import { getPrinting, openIndex } from "../lib/cardindex.js";

export const VERSION = process.env.APP_VERSION || "dev";

// Anything printed by accident (a library, a stray debug line) must not corrupt
// the protocol stream.
console.log = console.info = console.debug = (...args) => console.error(...args);
export const log = (...args) => console.error("[mcp-collection]", ...args);

// The DB is opened on first use so the handshake succeeds even when the volume
// is unavailable; tool calls then report the error instead.
let db;
export const getDb = () => (db ??= openDb());

// The card index (read-only, optional): printing facts for edit_copies (other
// languages of a printing, finishes). The CLI passes only DB_FILE, so the index
// is looked for next to the app DB when INDEX_DB_FILE is not set.
let idx;
export function getIndex() {
  if (idx !== undefined) return idx;
  idx = null;
  const dbFile = process.env.DB_FILE || "/data/mtg-planner.db";
  const file = [process.env.INDEX_DB_FILE, path.join(path.dirname(dbFile), "cardindex.db")].find((f) => f && existsSync(f));
  if (file) {
    try { idx = openIndex(file, { readOnly: true }); } catch (err) { log(`card index unavailable (${err.message})`); }
  }
  return idx;
}
// Combo checks (Commander Spellbook): the turn waits at most COMBO_WAIT_MS for one.
export const COMBO_WAIT_MS = 8000;
let combosScheduler;
export const combos = () => (combosScheduler ??= createSpellbookScheduler({ db: () => getDb(), version: VERSION, log: { warn: (m) => log(m) } }));

export const indexPrinting = (id) => {
  const i = getIndex();
  if (!i) return null;
  try { return getPrinting(i, id); } catch { return null; }
};

/** Close the DB and the index (stdin closed, all calls done). */
export function closeAll() {
  try { db?.close(); } catch { /* ignore */ }
  try { idx?.close(); } catch { /* ignore */ }
}
