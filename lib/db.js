// SQLite storage shared by the web server and the collection MCP server.
//
// Both processes open the same file (the MCP server is spawned per chat turn by
// the Claude CLI), so the database runs in WAL mode with a busy timeout.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { recordDeckVersion } from "./deckhistory.js";

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
  // v6: deck status (idea | built). Built decks claim owned copies (lib/allocation.js
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
  // v9: deck insights. cards gain the Scryfall facts the bracket/stats need
  // (game_changer NULL = not fetched yet, 0/1 otherwise; produced_mana JSON;
  // layout); existing rows stay NULL until the card backfill re-fetches them
  // (lib/manabox.js backfillCardFacts). decks.bracket_declared = the user's
  // bracket (NULL = auto); deck_cards.companion marks a Companion-section row
  // (board side); spellbook_cache holds Commander Spellbook answers per card set.
  (db) => {
    const has = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const cards = has("cards");
    if (!cards.has("game_changer")) db.exec("ALTER TABLE cards ADD COLUMN game_changer INTEGER");
    if (!cards.has("produced_mana")) db.exec("ALTER TABLE cards ADD COLUMN produced_mana TEXT");
    if (!cards.has("layout")) db.exec("ALTER TABLE cards ADD COLUMN layout TEXT");
    if (!has("decks").has("bracket_declared")) db.exec("ALTER TABLE decks ADD COLUMN bracket_declared INTEGER");
    if (!has("deck_cards").has("companion")) db.exec("ALTER TABLE deck_cards ADD COLUMN companion INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE TABLE IF NOT EXISTS spellbook_cache (
        key          TEXT PRIMARY KEY,
        fetched_at   TEXT,
        last_used_at TEXT,
        status       TEXT,
        error        TEXT,
        tag_raw      TEXT,
        parser       INTEGER,
        result       TEXT
      );
    `);
  },
  // v10: deck history + build checklist. deck_versions holds a snapshot per deck change
  // (lib/deckhistory.js; every existing deck gets one baseline version, actor 'system');
  // deck_build_picks the build checklist's ticks per card key and source (lib/deckbuild.js).
  // Both are new tables only (additive) and go with their deck (ON DELETE CASCADE).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deck_versions (
        id            INTEGER PRIMARY KEY,
        deck_id       INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        at            TEXT NOT NULL,
        actor         TEXT NOT NULL,
        summary       TEXT NOT NULL,
        hash          TEXT NOT NULL,
        card_count    INTEGER NOT NULL,
        meta          TEXT NOT NULL,
        cards         TEXT NOT NULL,
        restored_from INTEGER
      );
      CREATE INDEX IF NOT EXISTS deck_versions_deck ON deck_versions(deck_id, id);
      CREATE TABLE IF NOT EXISTS deck_build_picks (
        deck_id  INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        card_key TEXT NOT NULL,
        source   TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        at       TEXT NOT NULL,
        PRIMARY KEY (deck_id, card_key, source)
      );
    `);
    for (const d of db.prepare("SELECT id, updated_at FROM decks WHERE id NOT IN (SELECT deck_id FROM deck_versions)").all()) {
      const at = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(d.updated_at ?? "") ? `${d.updated_at.replace(" ", "T")}.000Z` : null;
      recordDeckVersion(db, d.id, { actor: "system", summary: "Saved before the history started", at });
    }
  },
  // v11: wishlist (lib/wishlist.js). One row per wanted card: oracle_id + name,
  // the reference printing (scryfall_id: image, price, history key) and whether
  // only that printing counts (any_printing 0) or any printing of the card
  // (1). finish/language NULL = any. max_price_eur NULL = no limit; priority
  // 1 high, 2 normal, 3 low; source app | claude.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wishlist (
        id            INTEGER PRIMARY KEY,
        oracle_id     TEXT NOT NULL,
        name          TEXT NOT NULL,
        scryfall_id   TEXT NOT NULL,
        any_printing  INTEGER NOT NULL DEFAULT 1,
        finish        TEXT,
        language      TEXT,
        quantity      INTEGER NOT NULL DEFAULT 1,
        max_price_eur REAL,
        note          TEXT,
        priority      INTEGER NOT NULL DEFAULT 2,
        source        TEXT NOT NULL DEFAULT 'app',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS wishlist_oracle ON wishlist(oracle_id);
    `);
  },
  // v12: value history (lib/finance.js). value_history = one row per local day
  // (total EUR value, copies, printings, unpriced copies; rewritten during the
  // day), value_history_binders = the same per binder. card_history stores per
  // printing + finish the held quantity and unit EUR price, ONLY when one of
  // them changed (the state on day D is the newest row with day <= D), for
  // owned and wishlist printings. The first snapshot is written at boot.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS value_history (
        day        TEXT PRIMARY KEY,
        value_eur  REAL NOT NULL,
        copies     INTEGER NOT NULL,
        printings  INTEGER NOT NULL,
        unpriced   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS value_history_binders (
        day       TEXT NOT NULL,
        binder    TEXT NOT NULL,
        value_eur REAL NOT NULL,
        copies    INTEGER NOT NULL,
        PRIMARY KEY (day, binder)
      );
      CREATE TABLE IF NOT EXISTS card_history (
        scryfall_id TEXT NOT NULL,
        finish      TEXT NOT NULL,
        day         TEXT NOT NULL,
        quantity    INTEGER NOT NULL,
        eur         REAL,
        PRIMARY KEY (scryfall_id, finish, day)
      );
      CREATE INDEX IF NOT EXISTS card_history_day ON card_history(day);
    `);
  },
  // v13: no-op placeholder (unused; kept so v14 stays at its number).
  () => {},
  // v14: binder type (binder | deck_box | bulk | trade | other; NULL = auto:
  // lib/binders.js autoBinderType decides from the name and the linked decks on
  // every read, so a binder that later becomes a deck box follows) and the
  // user's cover card (NULL = the binder's most valuable card).
  (db) => {
    const cols = new Set(db.prepare("PRAGMA table_info(binders)").all().map((c) => c.name));
    if (!cols.has("type")) db.exec("ALTER TABLE binders ADD COLUMN type TEXT");
    if (!cols.has("cover_scryfall_id")) db.exec("ALTER TABLE binders ADD COLUMN cover_scryfall_id TEXT");
  },
  // v15: tokens & extras (lib/accessories.js). cards.all_parts = Scryfall's related token /
  // helper-card printings (JSON, '[]' = none, NULL = not fetched since v15), power/toughness
  // (token details). Additive; the card-facts backfill (lib/manabox.js) re-fetches deck and
  // owned rows still NULL, so its last-run meta is reset to run once more (also for ids it skipped).
  (db) => {
    const cols = new Set(db.prepare("PRAGMA table_info(cards)").all().map((c) => c.name));
    if (!cols.has("all_parts")) db.exec("ALTER TABLE cards ADD COLUMN all_parts TEXT");
    if (!cols.has("power")) db.exec("ALTER TABLE cards ADD COLUMN power TEXT");
    if (!cols.has("toughness")) db.exec("ALTER TABLE cards ADD COLUMN toughness TEXT");
    db.exec("DELETE FROM meta WHERE key = 'cards_v9_backfill'");
  },
  // v16: binder lock (lib/deckboxes.js). binders.locked = the user's choice (1 locked, 0
  // unlocked), NULL = auto (locked while the effective type is deck_box, decided on every
  // read). Additive: existing deck boxes stay locked, every other binder starts unlocked.
  (db) => {
    const cols = new Set(db.prepare("PRAGMA table_info(binders)").all().map((c) => c.name));
    if (!cols.has("locked")) db.exec("ALTER TABLE binders ADD COLUMN locked INTEGER");
  },
  // v17: favourites (UI filters "★ Favourites" on the Decks and Binders pages). 0/1, additive.
  // Not a deck change: setting it touches neither decks.updated_at nor the deck history.
  (db) => {
    const deckCols = new Set(db.prepare("PRAGMA table_info(decks)").all().map((c) => c.name));
    if (!deckCols.has("favorite")) db.exec("ALTER TABLE decks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
    const binderCols = new Set(db.prepare("PRAGMA table_info(binders)").all().map((c) => c.name));
    if (!binderCols.has("favorite")) db.exec("ALTER TABLE binders ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
  },
  // v18: deck guides (lib/deckguide.js). One row per generated guide, the newest few per deck;
  // data = the facts + Claude's sections as JSON. deck_version_id = the deck's newest history
  // version when it was made (a later version = "the deck changed since"). Additive.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS deck_guides (
      id              INTEGER PRIMARY KEY,
      deck_id         INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      created_at      TEXT NOT NULL,
      deck_version_id INTEGER,
      kind            TEXT NOT NULL,
      model           TEXT,
      cost_usd        REAL,
      data            TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS deck_guides_deck ON deck_guides(deck_id, id)");
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
  // Nested (a helper that runs in its own transaction, called inside another): a savepoint, so the
  // inner part rolls back alone on an error and the outer one still decides about the whole.
  if (db.isTransaction) {
    db.exec("SAVEPOINT nested");
    try {
      const result = fn();
      db.exec("RELEASE nested");
      return result;
    } catch (err) {
      db.exec("ROLLBACK TO nested");
      db.exec("RELEASE nested");
      throw err;
    }
  }
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
  "game_changer", "produced_mana", "layout", "all_parts", "power", "toughness",
];
// Card facts an offline fallback row (index data, fetched_at '') may not know:
// a NULL never wipes a value a Scryfall fetch stored. cmc keeps the plain
// overwrite (a fresh fetch is authoritative).
const KEEP_KNOWN = new Set(["game_changer", "produced_mana", "layout", "all_parts", "power", "toughness"]);

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
     ON CONFLICT(scryfall_id) DO UPDATE SET ${CARD_COLUMNS.slice(1).map((c) => `${c} = ${c === "prices" ? KEEP_EN_PRICES
       : KEEP_KNOWN.has(c) ? `COALESCE(excluded.${c}, cards.${c})` : `excluded.${c}`}`).join(", ")}`,
  );
  for (const card of cards) stmt.run(...CARD_COLUMNS.map((c) => card[c] ?? null));
}

/**
 * Add copies to a collection row key (merge into an existing row; a known purchase price stays).
 * Params: scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source.
 */
export const UPSERT_COPIES = `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, purchase_currency, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (scryfall_id, finish, language, condition, binder, source)
  DO UPDATE SET quantity = quantity + excluded.quantity,
                purchase_price = COALESCE(purchase_price, excluded.purchase_price),
                purchase_currency = COALESCE(purchase_currency, excluded.purchase_currency)`;

/** fetched_at of a cards row built from the local index: re-fetched from Scryfall at the next chance. */
export const FALLBACK_FETCHED_AT = "";

/**
 * A cards row from a local-index printing, for when Scryfall can't be reached. The index has no
 * colours or legalities: colours are approximated from the mana cost, the EUR prices come from the
 * index (bulk data, when it has them), and the row is marked (FALLBACK_FETCHED_AT) so the next
 * successful scan commit replaces it with Scryfall's data.
 */
export function cardRowFromIndex(p) {
  const colors = "WUBRG".split("").filter((c) => String(p.mana_cost || "").includes(c)).join("");
  const prices = {};
  for (const k of ["eur", "eur_foil", "eur_etched"]) if (p[k] != null) prices[k] = String(p[k]);
  return {
    scryfall_id: p.id, oracle_id: p.oracle_id || p.id, name: p.name, set_code: p.set_code, set_name: p.set_name ?? null,
    collector_number: p.collector_number, lang: p.lang, rarity: p.rarity ?? null, type_line: p.type_line ?? null,
    mana_cost: p.mana_cost ?? null, cmc: null, colors, color_identity: colors, oracle_text: null, keywords: "[]",
    legalities: "{}", prices: JSON.stringify(prices), image_small: p.image_small ?? p.faces?.[0]?.image_small ?? null,
    image_normal: p.image_normal ?? p.faces?.[0]?.image_normal ?? null, scryfall_uri: null, fetched_at: FALLBACK_FETCHED_AT,
    // Index facts when the index has them; NULL never wipes a known value (upsertCards).
    game_changer: p.game_changer ?? null, produced_mana: p.produced_mana ?? null, layout: p.layout ?? null,
  };
}

/** Suffix of the English-twin price keys in a foreign printing's `prices` (eur_en, eur_foil_en, eur_etched_en, id_en). */
export const EN_PRICE_SUFFIX = "_en";

const priceNumber = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Parsed JSON text column: null, '', bad JSON and a JSON null give `fallback`; non-strings pass through. */
export function parseJson(v, fallback = null) {
  if (v == null || v === "") return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
}

/** Parsed `prices` of a card row ({} for missing or bad JSON). */
export const parsePrices = (prices) => parseJson(prices, {}) || {};

/** Scryfall EUR price key of a collection finish: normal → eur, foil → eur_foil, etched → eur_etched. */
export const eurKey = (finish) => (finish === "foil" ? "eur_foil" : finish === "etched" ? "eur_etched" : "eur");

/** Euros rounded to cents. */
export const round2 = (v) => Math.round(v * 100) / 100;

/** The current time as an ISO string (log and version timestamps). */
export const nowIso = () => new Date().toISOString();

/** A copy's language code as stored (lowercase): en, de, ja, zhs, and ManaBox's pt_br / zh-cn forms. */
export const LANG_RE = /^[a-z]{2,3}(?:[_-][a-z]{2,4})?$/;
/** A Scryfall id (UUID; Scryfall writes them lowercase). */
export const SCRYFALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user string as a literal LIKE pattern (with ESCAPE '\'): % and _ match only themselves. */
export const likeEsc = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * SQL condition: the card name column `col` is `?` (case-insensitive) or `?` is its front face
 * ("Name // Back"). Bind nameArgs(name) for its two parameters.
 */
export const nameMatch = (col = "c.name") => `(${col} = ? COLLATE NOCASE OR ${col} LIKE ? || ' // %' ESCAPE '\\')`;
/** The two parameters of nameMatch(). */
export const nameArgs = (name) => [name, likeEsc(name)];

/**
 * EUR price under one Scryfall key (eur | eur_foil | eur_etched) of a parsed
 * `prices`: the printing's own, else its English twin's (`<key>_en`, same set
 * + collector number; Scryfall rarely prices foreign printings). Never USD.
 */
export function eurOf(prices, key) {
  return priceNumber(prices?.[key]) ?? priceNumber(prices?.[key + EN_PRICE_SUFFIX]);
}

/**
 * EUR price of a card row for a finish, falling back to the plain price, then
 * any other finish. Returns { value, currency: "€" } or null; never USD (a card
 * with only a USD price is unpriced, as in every value total). A foreign
 * printing without its own EUR price uses its English twin's (eurOf); `en: true`
 * marks such a value.
 */
export function cardPrice(card, finish = "normal") {
  const prices = parsePrices(card.prices);
  const suffix = finish === "foil" ? "_foil" : finish === "etched" ? "_etched" : "";
  const found = (key) => {
    const own = priceNumber(prices[key]);
    if (own != null) return { value: own, currency: "€" };
    const en = priceNumber(prices[key + EN_PRICE_SUFFIX]);
    return en == null ? null : { value: en, currency: "€", en: true };
  };
  // Foil-only / etched-only printings have no plain price: use whatever finish
  // Scryfall does price rather than reporting nothing.
  return found("eur" + suffix) ?? found("eur") ?? found("eur_foil") ?? found("eur_etched");
}

/**
 * EUR total that doesn't depend on the summing order: each unit price × copies
 * is added as integer micro-euros (exact in a double), rounded to cents once at
 * the end. stats() and lib/finance.js both use it, so the header value and the
 * Market tab always agree (float sums in another order could differ by a cent
 * on a half-cent total). `add(unit, copies)`, `value` = euros with 2 decimals.
 */
export function eurTotal() {
  let micro = 0;
  return {
    add(unit, copies = 1) { micro += Math.round(unit * 1e6) * copies; },
    get value() { return Math.round(micro / 1e4) / 100; },
  };
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
  const value = eurTotal();
  const rows = db.prepare(
    `SELECT c.prices, col.finish, col.quantity FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id ${where}`,
  ).all(...args);
  for (const r of rows) {
    const p = cardPrice(r, r.finish);
    if (p && p.currency === "€") value.add(p.value, r.quantity);
  }
  const decks = db.prepare("SELECT COUNT(*) AS n FROM decks").get().n;
  const lastImport = db.prepare("SELECT created_at, summary FROM imports WHERE kind = 'manabox' ORDER BY id DESC LIMIT 1").get();
  const master = getAppMeta(db, "collection_master") === "app" ? "app" : "manabox";
  return { ...totals, ...(binder == null ? {} : { binder: String(binder) }), value_eur: value.value, decks, last_import: lastImport?.created_at ?? null, collection_master: master };
}
