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
  // v4: binders exist on their own (empty binders, lib/binders.js). Backfilled
  // from the binder names in use; origin 'manabox' marks binders that only hold
  // ManaBox rows, so a replace import may drop them once they are empty.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS binders (
        name       TEXT PRIMARY KEY COLLATE NOCASE,
        origin     TEXT NOT NULL DEFAULT 'app',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO binders (name, origin)
        SELECT binder, CASE WHEN SUM(source <> 'manabox') > 0 THEN 'app' ELSE 'manabox' END
          FROM collection WHERE binder <> '' GROUP BY binder ORDER BY MIN(id);
    `);
  },
  // v5: the last ManaBox export as seen by the app (lib/manabox.js delta
  // import: only increases vs this snapshot are added). Backfilled from the
  // rows that still carry source 'manabox'.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS manabox_snapshot (
        scryfall_id TEXT NOT NULL,
        finish      TEXT NOT NULL,
        language    TEXT NOT NULL,
        condition   TEXT NOT NULL,
        binder      TEXT NOT NULL COLLATE NOCASE,
        quantity    INTEGER NOT NULL,
        PRIMARY KEY (scryfall_id, finish, language, condition, binder)
      );
      INSERT OR IGNORE INTO manabox_snapshot (scryfall_id, finish, language, condition, binder, quantity)
        SELECT scryfall_id, finish, language, condition, MIN(binder), SUM(quantity)
          FROM collection WHERE source = 'manabox'
         GROUP BY scryfall_id, finish, language, condition, lower(binder);
    `);
  },
  // v6: deck status (idea | built). Built decks claim owned copies (lib/decks.js
  // allocation). ManaBox binder decks are physical decks: built.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(decks)").all().map((c) => c.name);
    if (!cols.includes("status")) {
      db.exec("ALTER TABLE decks ADD COLUMN status TEXT NOT NULL DEFAULT 'idea'");
      db.exec("UPDATE decks SET status = 'built' WHERE source = 'manabox'");
    }
  },
  // v7: decks remember their ManaBox binder (re-syncs match on it, so a deck
  // renamed in the app is not recreated) and the binder they were boxed into
  // (protected from other decks, also after a rename). Collection rows whose
  // binder differs only in case are merged onto one spelling.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(decks)").all().map((c) => c.name);
    if (!cols.includes("manabox_binder")) db.exec("ALTER TABLE decks ADD COLUMN manabox_binder TEXT");
    if (!cols.includes("box_binder")) db.exec("ALTER TABLE decks ADD COLUMN box_binder TEXT");
    db.exec("UPDATE decks SET manabox_binder = name WHERE source = 'manabox' AND manabox_binder IS NULL");
    db.exec(`UPDATE decks SET box_binder = (SELECT b.name FROM binders b WHERE b.name = 'Deck box: ' || decks.name)
              WHERE box_binder IS NULL AND EXISTS (SELECT 1 FROM binders b WHERE b.name = 'Deck box: ' || decks.name)`);
    // Canonical spelling per binder: the binders table, else the oldest row's.
    const variants = db.prepare(
      `SELECT lower(binder) AS k FROM collection WHERE binder <> '' GROUP BY lower(binder) HAVING COUNT(DISTINCT binder) > 1`,
    ).all();
    for (const { k } of variants) {
      const canon = db.prepare("SELECT name FROM binders WHERE name = ?").get(k)?.name
        ?? db.prepare("SELECT binder FROM collection WHERE lower(binder) = ? ORDER BY id LIMIT 1").get(k).binder;
      const others = db.prepare("SELECT * FROM collection WHERE lower(binder) = ? AND binder <> ?").all(k, canon);
      for (const r of others) {
        db.prepare("DELETE FROM collection WHERE id = ?").run(r.id);
        db.prepare(
          `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (scryfall_id, finish, language, condition, binder, source) DO UPDATE SET quantity = quantity + excluded.quantity`,
        ).run(r.scryfall_id, r.finish, r.language, r.condition, canon, r.quantity, r.purchase_price, r.purchase_currency, r.source);
      }
    }
  },
  // v8: edit log of owned copies (lib/edits.js): every edit / delete / relanguage
  // stores the exact before/after state of each collection row key it touched
  // (JSON `changes`), so it can be undone exactly; undone_at marks an undo.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_edits (
        id         INTEGER PRIMARY KEY,
        at         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        actor      TEXT NOT NULL,
        summary    TEXT NOT NULL,
        copies     INTEGER NOT NULL,
        changes    TEXT NOT NULL,
        undone_at  TEXT
      );
    `);
  },
];

/** Schema version (PRAGMA user_version) this app migrates to. */
export const SCHEMA_VERSION = MIGRATIONS.length;

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
  // synchronous=NORMAL: in WAL mode commits skip the fsync (checkpoints still
  // sync; a power cut can lose the last commits but never corrupts). With the
  // default FULL every commit blocked the event loop ~40 ms on a spinning
  // disk, so staging one scan stalled the server for 100-235 ms.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
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

// A re-fetched card row keeps the English-twin prices (the `*_en` keys that
// lib/prices.js syncEnglishPrices adds to foreign printings) unless the new
// prices carry their own: Scryfall's data for a foreign printing has none, and
// a price refresh would otherwise drop the card's value until the next sync.
const KEEP_EN_PRICES = `CASE WHEN instr(cards.prices, '_en"') > 0 AND json_valid(cards.prices) AND json_valid(excluded.prices)
  THEN json_patch((SELECT json_group_object(key, value) FROM json_each(cards.prices) WHERE substr(key, -3) = '_en'), excluded.prices)
  ELSE excluded.prices END`;

export function upsertCards(db, cards) {
  const stmt = db.prepare(
    `INSERT INTO cards (${CARD_COLUMNS.join(", ")}) VALUES (${CARD_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(scryfall_id) DO UPDATE SET ${CARD_COLUMNS.slice(1).map((c) => `${c} = ${c === "prices" ? KEEP_EN_PRICES : `excluded.${c}`}`).join(", ")}`,
  );
  for (const card of cards) stmt.run(...CARD_COLUMNS.map((c) => card[c] ?? null));
}

/** Suffix of the English-twin price keys in a foreign printing's `prices` (eur_en, eur_foil_en, eur_etched_en, id_en). */
export const EN_PRICE_SUFFIX = "_en";

const priceNumber = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Parsed `prices` of a card row ({} for missing or bad JSON). */
export function parsePrices(prices) {
  if (!prices) return {};
  if (typeof prices !== "string") return prices;
  try { return JSON.parse(prices) || {}; } catch { return {}; }
}

/**
 * EUR price under one Scryfall key (eur | eur_foil | eur_etched) of a parsed
 * `prices`: the printing's own, else its English twin's (`<key>_en`, same set
 * + collector number; Scryfall rarely prices foreign printings). Never USD.
 */
export function eurOf(prices, key) {
  return priceNumber(prices?.[key]) ?? priceNumber(prices?.[key + EN_PRICE_SUFFIX]);
}

/**
 * Eur price of a card row for a finish, falling back to the plain price, then
 * usd, then any other finish. Returns { value, currency } or null. A foreign
 * printing without its own EUR price uses its English twin's (eurOf) before
 * any USD price; `en: true` marks such a value.
 */
export function cardPrice(card, finish = "normal") {
  const prices = parsePrices(card.prices);
  const suffix = finish === "foil" ? "_foil" : finish === "etched" ? "_etched" : "";
  const found = (key, sym) => {
    const own = priceNumber(prices[key]);
    if (own != null) return { value: own, currency: sym };
    const en = sym === "€" ? priceNumber(prices[key + EN_PRICE_SUFFIX]) : null;
    return en == null ? null : { value: en, currency: sym, en: true };
  };
  for (const [cur, sym] of [["eur", "€"], ["usd", "$"]]) {
    const v = found(cur + suffix, sym) ?? found(cur, sym);
    if (v) return v;
  }
  // Foil-only / etched-only printings have no plain price: use whatever finish
  // Scryfall does price rather than reporting nothing.
  for (const [cur, sym] of [["eur", "€"], ["usd", "$"]]) {
    const v = found(cur + "_foil", sym) ?? found(cur + "_etched", sym);
    if (v) return v;
  }
  return null;
}

export function formatPrice(p) {
  return p ? `${p.currency}${p.value.toFixed(2)}` : "n/a";
}

/**
 * Collection totals for the header: unique_cards, printings, total_cards,
 * value_eur (each copy at its finish's EUR price), decks, last_import,
 * collection_master. `binder` (exact, case-insensitive, '' = Unsorted, like
 * /api/collection) restricts the counts and value to that binder's copies and
 * echoes `binder`; decks/last_import/master stay global.
 */
export function stats(db, { binder = null } = {}) {
  const where = binder == null ? "" : "WHERE col.binder = ? COLLATE NOCASE";
  const args = binder == null ? [] : [String(binder)];
  const totals = db.prepare(
    `SELECT COUNT(DISTINCT c.oracle_id) AS unique_cards, COUNT(DISTINCT c.scryfall_id) AS printings,
            COALESCE(SUM(col.quantity), 0) AS total_cards
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id ${where}`,
  ).get(...args);
  let value = 0;
  const rows = db.prepare(
    `SELECT c.prices, col.finish, col.quantity FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id ${where}`,
  ).all(...args);
  for (const r of rows) {
    const p = cardPrice(r, r.finish);
    if (p && p.currency === "€") value += p.value * r.quantity;
  }
  const decks = db.prepare("SELECT COUNT(*) AS n FROM decks").get().n;
  const lastImport = db.prepare("SELECT created_at, summary FROM imports WHERE kind = 'manabox' ORDER BY id DESC LIMIT 1").get();
  const master = getAppMeta(db, "collection_master") === "app" ? "app" : "manabox";
  return { ...totals, ...(binder == null ? {} : { binder: String(binder) }), value_eur: Math.round(value * 100) / 100, decks, last_import: lastImport?.created_at ?? null, collection_master: master };
}
