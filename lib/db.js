// SQLite storage shared by the web server and the collection MCP server.
//
// Both processes open the same file (the MCP server is spawned per chat turn by
// the Claude CLI), so the database runs in WAL mode with a busy timeout.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  scryfall_id      TEXT PRIMARY KEY,
  oracle_id        TEXT,
  name             TEXT NOT NULL,
  set_code         TEXT,
  set_name         TEXT,
  collector_number TEXT,
  lang             TEXT,
  rarity           TEXT,
  type_line        TEXT,
  mana_cost        TEXT,
  cmc              REAL,
  colors           TEXT NOT NULL DEFAULT '',
  color_identity   TEXT NOT NULL DEFAULT '',
  oracle_text      TEXT,
  keywords         TEXT,
  legalities       TEXT,
  prices           TEXT,
  image_small      TEXT,
  image_normal     TEXT,
  scryfall_uri     TEXT,
  fetched_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_name   ON cards(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS cards_oracle ON cards(oracle_id);

CREATE TABLE IF NOT EXISTS collection (
  id                INTEGER PRIMARY KEY,
  scryfall_id       TEXT NOT NULL REFERENCES cards(scryfall_id),
  finish            TEXT NOT NULL DEFAULT 'normal',
  language          TEXT NOT NULL DEFAULT 'en',
  condition         TEXT NOT NULL DEFAULT 'near_mint',
  binder            TEXT NOT NULL DEFAULT '',
  quantity          INTEGER NOT NULL,
  purchase_price    REAL,
  purchase_currency TEXT,
  source            TEXT NOT NULL DEFAULT 'manabox',
  UNIQUE (scryfall_id, finish, language, condition, binder, source)
);
CREATE INDEX IF NOT EXISTS collection_card ON collection(scryfall_id);

CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  format      TEXT,
  description TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  board       TEXT NOT NULL DEFAULT 'main',
  name        TEXT NOT NULL,
  scryfall_id TEXT REFERENCES cards(scryfall_id),
  quantity    INTEGER NOT NULL,
  PRIMARY KEY (deck_id, board, name)
);

CREATE TABLE IF NOT EXISTS imports (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  filename   TEXT,
  mode       TEXT,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tools      TEXT,
  cost_usd   REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Scanner staging list. `status` is the list state (staged | committed);
// `match_status` is how sure the identification was (auto | suggest | review)
// or that the user settled it (confirmed | manual). printing_id is the printing
// that was detected, store_printing_id the one stored (storage language).
const SCANS = `
CREATE TABLE IF NOT EXISTS scans (
  id                INTEGER PRIMARY KEY,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'staged',
  match_status      TEXT NOT NULL DEFAULT 'auto',
  printing_id       TEXT,
  store_printing_id TEXT,
  oracle_id         TEXT,
  name              TEXT,
  printed_name      TEXT,
  set_code          TEXT,
  set_name          TEXT,
  collector_number  TEXT,
  rarity            TEXT,
  image_small       TEXT,
  image_normal      TEXT,
  finishes          TEXT,
  lang_detected     TEXT,
  store_lang        TEXT,
  finish            TEXT NOT NULL DEFAULT 'normal',
  finish_source     TEXT,
  condition         TEXT NOT NULL DEFAULT 'near_mint',
  quantity          INTEGER NOT NULL DEFAULT 1,
  confidence        REAL,
  method            TEXT,
  candidates        TEXT,
  variants          TEXT,
  features          TEXT,
  image_path        TEXT,
  strip_path        TEXT,
  calibration       INTEGER NOT NULL DEFAULT 0,
  calibration_truth TEXT,
  last_action       TEXT,
  committed_at      TEXT,
  committed_to      TEXT
);
CREATE INDEX IF NOT EXISTS scans_status ON scans(status, id);
`;

// Schema migrations, keyed by PRAGMA user_version. Version 0 is the original
// schema; the collection table got a `source` column (manabox | scan) so a
// ManaBox "replace" import only replaces what came from ManaBox.
const MIGRATIONS = [
  (db) => {
    const cols = db.prepare("PRAGMA table_info(collection)").all().map((c) => c.name);
    if (!cols.includes("source")) {
      // SQLite cannot change a UNIQUE constraint in place: rebuild the table.
      db.exec(`
        CREATE TABLE collection_v1 (
          id                INTEGER PRIMARY KEY,
          scryfall_id       TEXT NOT NULL REFERENCES cards(scryfall_id),
          finish            TEXT NOT NULL DEFAULT 'normal',
          language          TEXT NOT NULL DEFAULT 'en',
          condition         TEXT NOT NULL DEFAULT 'near_mint',
          binder            TEXT NOT NULL DEFAULT '',
          quantity          INTEGER NOT NULL,
          purchase_price    REAL,
          purchase_currency TEXT,
          source            TEXT NOT NULL DEFAULT 'manabox',
          UNIQUE (scryfall_id, finish, language, condition, binder, source)
        );
        INSERT INTO collection_v1 (id, scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
          SELECT id, scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, 'manabox' FROM collection;
        DROP TABLE collection;
        ALTER TABLE collection_v1 RENAME TO collection;
        CREATE INDEX IF NOT EXISTS collection_card ON collection(scryfall_id);
      `);
    }
    db.exec(SCANS);
  },
  // v2: scans.undo keeps the columns an edit changed, so undo can revert it.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(scans)").all().map((c) => c.name);
    if (!cols.includes("undo")) db.exec("ALTER TABLE scans ADD COLUMN undo TEXT");
  },
  // v3: key/value app state (scheduler last runs, ...).
  (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  },
];

/** Bring the schema up to date (PRAGMA user_version); safe to call repeatedly. */
export function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= MIGRATIONS.length) return;
  // The collection rebuild drops a table that cards rows are referenced from;
  // foreign keys must be off for that and cannot be toggled inside a transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have migrated meanwhile.
        if (db.prepare("PRAGMA user_version").get().user_version > v) { db.exec("COMMIT"); continue; }
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function openDb(file = process.env.DB_FILE || "/data/mtg-planner.db") {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** App key/value state (meta table), or null. */
export function getAppMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}
export function setAppMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value == null ? null : String(value));
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const CARD_COLUMNS = [
  "scryfall_id", "oracle_id", "name", "set_code", "set_name", "collector_number", "lang",
  "rarity", "type_line", "mana_cost", "cmc", "colors", "color_identity", "oracle_text",
  "keywords", "legalities", "prices", "image_small", "image_normal", "scryfall_uri", "fetched_at",
];

export function upsertCards(db, cards) {
  const stmt = db.prepare(
    `INSERT INTO cards (${CARD_COLUMNS.join(", ")}) VALUES (${CARD_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(scryfall_id) DO UPDATE SET ${CARD_COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
  );
  for (const card of cards) stmt.run(...CARD_COLUMNS.map((c) => card[c] ?? null));
}

/**
 * Eur price of a card row for a finish, falling back to the plain price, then
 * usd, then any other finish. Returns { value, currency } or null.
 */
export function cardPrice(card, finish = "normal") {
  const prices = typeof card.prices === "string" ? JSON.parse(card.prices || "{}") : card.prices || {};
  const suffix = finish === "foil" ? "_foil" : finish === "etched" ? "_etched" : "";
  for (const [cur, sym] of [["eur", "€"], ["usd", "$"]]) {
    const v = prices[cur + suffix] ?? prices[cur];
    if (v != null) return { value: Number(v), currency: sym };
  }
  // Foil-only / etched-only printings have no plain price: use whatever finish
  // Scryfall does price rather than reporting nothing.
  for (const [cur, sym] of [["eur", "€"], ["usd", "$"]]) {
    const v = prices[cur + "_foil"] ?? prices[cur + "_etched"];
    if (v != null) return { value: Number(v), currency: sym };
  }
  return null;
}

export function formatPrice(p) {
  return p ? `${p.currency}${p.value.toFixed(2)}` : "n/a";
}

export function stats(db) {
  const totals = db.prepare(
    `SELECT COUNT(DISTINCT c.oracle_id) AS unique_cards, COUNT(DISTINCT c.scryfall_id) AS printings,
            COALESCE(SUM(col.quantity), 0) AS total_cards
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id`,
  ).get();
  let value = 0;
  const rows = db.prepare(
    `SELECT c.prices, col.finish, col.quantity FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id`,
  ).all();
  for (const r of rows) {
    const p = cardPrice(r, r.finish);
    if (p && p.currency === "€") value += p.value * r.quantity;
  }
  const decks = db.prepare("SELECT COUNT(*) AS n FROM decks").get().n;
  const lastImport = db.prepare("SELECT created_at, summary FROM imports WHERE kind = 'manabox' ORDER BY id DESC LIMIT 1").get();
  return { ...totals, value_eur: Math.round(value * 100) / 100, decks, last_import: lastImport?.created_at ?? null };
}
