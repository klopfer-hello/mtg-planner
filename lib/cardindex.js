// Local Scryfall card index for the scanner.
//
// The scanner needs to turn a printed collector line ("001/269 M / M15 • EN",
// "M 0001 / MOM • DE", "123/249"), an OCR'd title or an image fingerprint into
// concrete printings without hammering api.scryfall.com (2 req/s on the lookup
// endpoints, 30 s lockout on 429). Scryfall's answer to that is the bulk data:
// we stream the gzipped `all_cards` JSONL (~400 MB gz, ~550k printings in all
// languages) into a SEPARATE SQLite file so the main DB stays small and the
// index can be thrown away and rebuilt at will.
//
// Collector-line keys follow what is actually printed on the card: promo sets
// (pbro, pmkm …) print the parent set's code and the number without the
// 's'/'p' suffix, The List (plst) prints the original "SET-N" line, and
// serialized / star variants drop their suffix. Lookups therefore match on
// set_code OR parent_set_code, on the digits of the collector number, and on
// plst rows numbered "SET-N".

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, pipeline } from "node:stream";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { eurKey } from "./db.js";

const API = "https://api.scryfall.com";
const USER_AGENT = process.env.SCRYFALL_USER_AGENT || "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)";
const BATCH = 2000;

// The printings table is created by name so a refresh can load a fresh copy
// into a staging table (no secondary indexes, sequential inserts) and swap
// it in atomically; readers keep seeing the old data until the commit.
const printingsTable = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id               TEXT PRIMARY KEY,
  oracle_id        TEXT,
  name             TEXT NOT NULL,
  printed_name     TEXT,
  lang             TEXT NOT NULL,
  set_code         TEXT NOT NULL,
  set_name         TEXT,
  parent_set_code  TEXT,
  set_type         TEXT,
  collector_number TEXT NOT NULL,
  cn_digits        INTEGER,
  released_at      TEXT,
  rarity           TEXT,
  finishes         TEXT,
  promo_types      TEXT,
  illustration_id  TEXT,
  frame            TEXT,
  border_color     TEXT,
  full_art         INTEGER NOT NULL DEFAULT 0,
  frame_effects    TEXT,
  layout           TEXT,
  image_status     TEXT,
  image_small      TEXT,
  image_normal     TEXT,
  faces            TEXT,
  type_line        TEXT,
  mana_cost        TEXT,
  eur              REAL,
  eur_foil         REAL,
  eur_etched       REAL,
  game_changer     INTEGER,
  produced_mana    TEXT
);`;
const PRINTINGS_INDEXES = `
CREATE INDEX IF NOT EXISTS printings_set_cn  ON printings(set_code, cn_digits, lang);
CREATE INDEX IF NOT EXISTS printings_parent  ON printings(parent_set_code, cn_digits);
CREATE INDEX IF NOT EXISTS printings_oracle  ON printings(oracle_id);
CREATE INDEX IF NOT EXISTS printings_ill     ON printings(illustration_id);
`;

const SCHEMA = `
${printingsTable("printings")}
${PRINTINGS_INDEXES}
CREATE TABLE IF NOT EXISTS sets (
  code            TEXT PRIMARY KEY,
  name            TEXT,
  parent_set_code TEXT,
  set_type        TEXT,
  released_at     TEXT,
  card_count      INTEGER,
  printed_size    INTEGER
);

-- One row per distinct (normalised title, lang, oracle card); FTS5 trigram
-- index on top for fuzzy OCR title lookup.
CREATE TABLE IF NOT EXISTS titles (
  id          INTEGER PRIMARY KEY,
  text        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  oracle_id   TEXT,
  name        TEXT,
  printed     TEXT,
  printing_id TEXT
);
CREATE INDEX IF NOT EXISTS titles_lang ON titles(lang);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS fingerprints (
  key             TEXT PRIMARY KEY,
  illustration_id TEXT,
  face            INTEGER NOT NULL DEFAULT 0,
  frame           TEXT,
  printing_id     TEXT,
  hash            BLOB NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  oracle_id       TEXT,
  name            TEXT
);
CREATE TABLE IF NOT EXISTS printing_fp (
  printing_id TEXT NOT NULL,
  face        INTEGER NOT NULL DEFAULT 0,
  key         TEXT NOT NULL,
  PRIMARY KEY (printing_id, face)
);
CREATE INDEX IF NOT EXISTS printing_fp_key ON printing_fp(key);
`;

/**
 * Open (and create) the card index database. WAL, busy timeout.
 * `readOnly` opens an existing index without touching the schema (the
 * fingerprint worker's connection).
 */
export function openIndex(file = process.env.INDEX_DB_FILE || "/data/cardindex.db", { readOnly = false } = {}) {
  if (readOnly) {
    // A read-only WAL connection needs the -shm file to exist already (the
    // server's own connection keeps it); otherwise fall back to query_only.
    let ro = null;
    try {
      ro = new DatabaseSync(file, { readOnly: true });
      ro.exec("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32768;");
      ro.prepare("SELECT 1 FROM meta LIMIT 1").get();
      ftsSchema(ro); // sets the module's FTS5 flag for searchTitle
      return ro;
    } catch {
      try { ro?.close(); } catch { /* not open */ }
      const q = new DatabaseSync(file);
      q.exec("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32768; PRAGMA query_only = ON;");
      ftsSchema(q);
      return q;
    }
  }
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const idx = new DatabaseSync(file);
  idx.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -32768;");
  idx.exec(SCHEMA);
  migrateIndex(idx);
  idx.exec(ftsSchema(idx));
  return idx;
}

// Indexes created before the fingerprint metadata was denormalized lack
// fingerprints.oracle_id/name. ADD COLUMN is O(1); the values are filled in
// later by syncFingerprintMeta (in a worker, in batches). NULL name = not
// filled in yet ('' = the printing is gone), found via a partial index.
// Older indexes also lack the EUR price columns (the scanner's "cash" sound
// at scan time) and the card facts game_changer/produced_mana (only for the
// offline card rows of lib/edits.js): they stay NULL until the next refreshIndex.
function migrateIndex(idx) {
  const cols = new Set(idx.prepare("PRAGMA table_info(fingerprints)").all().map((c) => c.name));
  if (!cols.has("oracle_id")) idx.exec("ALTER TABLE fingerprints ADD COLUMN oracle_id TEXT");
  if (!cols.has("name")) idx.exec("ALTER TABLE fingerprints ADD COLUMN name TEXT");
  idx.exec("CREATE INDEX IF NOT EXISTS fingerprints_meta_pending ON fingerprints(key) WHERE name IS NULL");
  const pcols = new Set(idx.prepare("PRAGMA table_info(printings)").all().map((c) => c.name));
  for (const c of PRICE_COLS) if (!pcols.has(c)) idx.exec(`ALTER TABLE printings ADD COLUMN ${c} REAL`);
  for (const [c, type] of FACT_COLS) if (!pcols.has(c)) idx.exec(`ALTER TABLE printings ADD COLUMN ${c} ${type}`);
}

// Card facts kept per printing (game_changer 0/1, NULL = unknown; produced_mana JSON text, not parsed).
const FACT_COLS = [["game_changer", "INTEGER"], ["produced_mana", "TEXT"]];

// EUR prices kept per printing (Scryfall bulk `prices`, Cardmarket trend).
const PRICE_COLS = ["eur", "eur_foil", "eur_etched"];
const priceNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * EUR price of an index printing for a finish (etched → eur_etched, foil →
 * eur_foil, else eur), or null when the index has none (old index, unpriced).
 */
export function printingPriceEur(p, finish = "normal") {
  if (!p) return null;
  return priceNum(p[eurKey(finish)]);
}

/**
 * Batch EUR prices for printings (GET /api/scans: the staged list's value).
 * `items` = [{id, finish}]; returns one {id, finish, eur, en_id, en_eur} per
 * item, in order: `eur` from the printing itself, and for a non-English
 * printing its English twin (same set + number) with that twin's price, the
 * same fallback as scanner.js scanPriceEur. Runs in the matcher worker
 * (INDEX_OPS): one point lookup per distinct id (twice for non-English).
 */
export function printingPricesEur(idx, items = []) {
  const byId = new Map();
  const one = idx.prepare("SELECT * FROM printings WHERE id = ?");
  const printing = (id) => {
    if (!byId.has(id)) {
      const p = toPrinting(one.get(id));
      const en = p && p.lang !== "en" ? storagePrinting(idx, p, "en") : null;
      byId.set(id, { p, en: en && en.id !== p.id ? en : null });
    }
    return byId.get(id);
  };
  return items.map(({ id, finish = "normal" } = {}) => {
    const { p, en } = id ? printing(String(id)) : { p: null, en: null };
    return { id: id ?? null, finish, eur: printingPriceEur(p, finish), en_id: en?.id ?? null, en_eur: printingPriceEur(en, finish) };
  });
}

/**
 * Read the index file (and its WAL) once, sequentially in 4 MiB chunks, so a
 * scan's lookups and fingerprint scoring hit the OS page cache: on a cold
 * disk they took seconds. Plain async file reads, not SQL: a long SQLite
 * statement (COUNT(*) over the printings, ~25 s cold) can't be interrupted,
 * so it held up worker.terminate() and with it the server's shutdown past
 * docker's stop timeout. Stops between chunks on `signal`. Returns {ms, bytes}.
 */
export async function warmIndex(file, { signal, chunk = 4 << 20 } = {}) {
  const t0 = Date.now();
  let bytes = 0;
  const buf = Buffer.allocUnsafe(chunk);
  for (const f of [file, `${file}-wal`]) {
    let fh;
    try { fh = await open(f, "r"); } catch { continue; } // no WAL: nothing to read
    try {
      for (;;) {
        if (signal?.aborted) return { ms: Date.now() - t0, bytes, aborted: true };
        const { bytesRead } = await fh.read(buf, 0, chunk, null);
        if (!bytesRead) break;
        bytes += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
  return { ms: Date.now() - t0, bytes };
}

/** True when some fingerprints still lack their oracle_id/name copy. */
export function fingerprintMetaPending(idx) {
  return Boolean(idx.prepare("SELECT 1 FROM fingerprints WHERE name IS NULL LIMIT 1").get());
}

/**
 * Copy oracle_id and name of each fingerprint's representative printing into
 * the fingerprints table, so the matcher loads without joining printings.
 * That join (and any per-row lookup) reads the large printings rows in random
 * order: 150 s on a cold disk for 78k fingerprints. This reads the printings
 * sequentially once instead (id, oracle_id, name) and updates by key.
 * `all` re-checks every row (after an index refresh), else only rows never
 * filled in. Yields every `batch` rows; bumps fp_generation when anything
 * changed so matchers reload. Options: all, batch, signal. Returns {updated, ms}.
 */
export async function syncFingerprintMeta(idx, { all = false, batch = 5000, signal } = {}) {
  const t0 = Date.now();
  const yieldNow = () => new Promise((res) => setImmediate(res));
  const fps = idx.prepare(`SELECT key, printing_id, oracle_id, name FROM fingerprints${all ? "" : " WHERE name IS NULL"}`).all();
  if (!fps.length) return { updated: 0, ms: Date.now() - t0 };
  const want = new Map(); // printing_id -> {oracle_id, name} (null until found)
  for (const f of fps) want.set(f.printing_id, null);
  let n = 0;
  for (const p of idx.prepare("SELECT id, oracle_id, name FROM printings").iterate()) {
    if (want.has(p.id)) want.set(p.id, { oracle_id: p.oracle_id ?? null, name: p.name });
    if (++n % batch === 0) {
      if (signal?.aborted) return { updated: 0, ms: Date.now() - t0, aborted: true };
      await yieldNow();
    }
  }
  // printing_id guard: the fingerprint job may have replaced the row meanwhile.
  const upd = idx.prepare("UPDATE fingerprints SET oracle_id = ?, name = ? WHERE key = ? AND printing_id IS ?");
  let updated = 0;
  let inTx = false;
  let inBatch = 0;
  try {
    for (const f of fps) {
      const v = want.get(f.printing_id) ?? { oracle_id: null, name: "" }; // '' = the printing is gone
      if (v.oracle_id === f.oracle_id && v.name === f.name) continue;
      if (!inTx) { idx.exec("BEGIN"); inTx = true; }
      updated += Number(upd.run(v.oracle_id, v.name, f.key, f.printing_id).changes);
      if (++inBatch >= batch) {
        idx.exec("COMMIT");
        inTx = false;
        inBatch = 0;
        if (signal?.aborted) break;
        await yieldNow();
      }
    }
    if (inTx) { idx.exec("COMMIT"); inTx = false; }
  } catch (e) {
    if (inTx) idx.exec("ROLLBACK");
    throw e;
  }
  if (updated) setMeta(idx, "fp_generation", `${Date.now()}`);
  return { updated, ms: Date.now() - t0 };
}

// FTS5 with the trigram tokenizer is available in node:sqlite (SQLite ≥ 3.34);
// fall back to a plain trigram table if a build lacks it.
let trigramFts = null;
function ftsSchema(idx) {
  if (trigramFts === null) {
    try {
      const probe = new DatabaseSync(":memory:");
      probe.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram remove_diacritics 1')");
      probe.close();
      trigramFts = true;
    } catch {
      trigramFts = false;
    }
  }
  return trigramFts
    ? "CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(text, content='titles', content_rowid='id', tokenize='trigram remove_diacritics 1');"
    : "CREATE TABLE IF NOT EXISTS title_grams (gram TEXT NOT NULL, title_id INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS title_grams_g ON title_grams(gram);";
}

export function getMeta(idx, key) {
  return idx.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}
export function setMeta(idx, key, value) {
  idx.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value == null ? null : String(value));
}

/** Digits of a collector number: "0010" → 10, "10s" → 10, "THB-103" → 103, "★1" → 1. */
export function cnDigits(cn) {
  if (cn == null) return null;
  const s = String(cn);
  const list = /^[A-Za-z0-9]+-(\d+)/.exec(s);
  const m = list || /(\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normTitle(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const J = (v) => (v == null ? null : JSON.stringify(v));

function rowFromCard(c, setsByCode) {
  const faces = c.card_faces || [];
  const top = c.image_uris || null;
  const img0 = top || faces[0]?.image_uris || {};
  const printed = c.printed_name || faces.map((f) => f.printed_name).filter(Boolean).join(" // ") || null;
  const set = setsByCode.get(c.set);
  return {
    id: c.id,
    oracle_id: c.oracle_id || faces[0]?.oracle_id || null,
    name: c.name,
    printed_name: printed,
    lang: c.lang,
    set_code: c.set,
    set_name: c.set_name || set?.name || null,
    parent_set_code: set?.parent_set_code || null,
    set_type: c.set_type || set?.set_type || null,
    collector_number: c.collector_number,
    cn_digits: cnDigits(c.collector_number),
    released_at: c.released_at || null,
    rarity: c.rarity || null,
    finishes: J(c.finishes || []),
    promo_types: J(c.promo_types || []),
    illustration_id: c.illustration_id || faces[0]?.illustration_id || null,
    frame: c.frame || null,
    border_color: c.border_color || null,
    full_art: c.full_art ? 1 : 0,
    frame_effects: J(c.frame_effects || []),
    layout: c.layout || null,
    image_status: c.image_status || null,
    image_small: img0.small || null,
    image_normal: img0.normal || null,
    faces: faces.length
      ? J(faces.map((f) => ({
          name: f.name || null,
          printed_name: f.printed_name || null,
          illustration_id: f.illustration_id || null,
          // Faces carry their own image only on double-faced layouts; split,
          // flip and adventure cards share the top-level image.
          image_small: top ? null : f.image_uris?.small || null,
          image_normal: top ? null : f.image_uris?.normal || null,
        })))
      : null,
    type_line: c.type_line ?? (faces.map((f) => f.type_line).filter(Boolean).join(" // ") || null),
    mana_cost: c.mana_cost ?? (faces.map((f) => f.mana_cost).filter(Boolean).join(" // ") || null),
    eur: priceNum(c.prices?.eur),
    eur_foil: priceNum(c.prices?.eur_foil),
    eur_etched: priceNum(c.prices?.eur_etched),
    game_changer: c.game_changer == null ? null : c.game_changer ? 1 : 0,
    produced_mana: c.produced_mana ? JSON.stringify(c.produced_mana)
      : faces.some((f) => f.produced_mana) ? JSON.stringify([...new Set(faces.flatMap((f) => f.produced_mana || []))]) : null,
  };
}

const COLS = [
  "id", "oracle_id", "name", "printed_name", "lang", "set_code", "set_name", "parent_set_code", "set_type",
  "collector_number", "cn_digits", "released_at", "rarity", "finishes", "promo_types", "illustration_id", "frame",
  "border_color", "full_art", "frame_effects", "layout", "image_status", "image_small", "image_normal", "faces",
  "type_line", "mana_cost", ...PRICE_COLS, ...FACT_COLS.map(([c]) => c),
];

async function scryfallJson(pathname, signal) {
  const res = await fetch(API + pathname, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`Scryfall ${pathname}: HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
});

async function loadSets(source, signal, { retries = 3, backoffMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadSetsOnce(source, signal);
    } catch (e) {
      if (signal?.aborted || attempt >= retries || Array.isArray(source)) throw e;
      await sleep(backoffMs * attempt, signal);
    }
  }
}

async function loadSetsOnce(source, signal) {
  if (Array.isArray(source)) return source;
  if (typeof source === "string" && !/^https?:/.test(source)) {
    const { readFile } = await import("node:fs/promises");
    const data = JSON.parse(await readFile(source, "utf8"));
    return data.data || data;
  }
  const all = [];
  let next = "/sets";
  while (next) {
    const data = await scryfallJson(next, signal);
    all.push(...(data.data || []));
    next = data.has_more && data.next_page ? data.next_page.replace(API, "") : null;
  }
  return all;
}

/**
 * Scryfall's current all_cards bulk entry: {updated_at, size, download_uri}.
 * One small GET of /bulk-data (no download), for "is there anything new?".
 */
export async function fetchBulkInfo({ signal } = {}) {
  const list = await scryfallJson("/bulk-data", signal);
  const entry = (list.data || []).find((e) => e.type === "all_cards");
  if (!entry) throw new Error("Scryfall bulk-data: no all_cards entry");
  return { updated_at: entry.updated_at || null, size: entry.size ?? null, download_uri: entry.jsonl_download_uri || entry.download_uri || null };
}

/** WAL checkpoint (TRUNCATE) to give the space of big writes back; false while readers block it. */
export function checkpointIndex(idx) {
  try {
    const r = idx.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return !r?.busy;
  } catch {
    return false;
  }
}

// Returns a Node Readable of the (decompressed) JSONL bulk file plus its
// Scryfall updated_at, from a local path, an explicit URL, or the bulk-data API.
async function openBulk(source, signal) {
  let url = source;
  let updatedAt = null;
  if (!source) {
    const list = await scryfallJson("/bulk-data", signal);
    const entry = (list.data || []).find((e) => e.type === "all_cards");
    if (!entry) throw new Error("Scryfall bulk-data: no all_cards entry");
    url = entry.jsonl_download_uri || entry.download_uri;
    updatedAt = entry.updated_at || null;
  }
  let raw;
  if (/^https?:/.test(url)) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, signal });
    if (!res.ok || !res.body) throw new Error(`bulk download: HTTP ${res.status}`);
    raw = Readable.fromWeb(res.body);
    // Scryfall serves application/gzip without Content-Encoding, so fetch
    // leaves it compressed; sniff the magic bytes either way below.
  } else {
    raw = createReadStream(url);
  }
  return { stream: await maybeGunzip(raw, signal), updatedAt, url };
}

async function maybeGunzip(raw, signal) {
  const it = raw[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const replay = Readable.from((async function* () {
    if (head.length) yield head;
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      const n = await it.next();
      if (n.done) return;
      yield Buffer.from(n.value);
    }
  })(), { objectMode: false });
  if (!gz) return replay;
  // pipeline (not pipe): a download error or abort must reach the consumer's
  // for-await as a rejection, not surface as an unhandled 'error' event that
  // takes the whole process down.
  const gunzip = createGunzip();
  pipeline(replay, gunzip, () => { /* errors propagate through gunzip */ });
  return gunzip;
}

async function* jsonLines(stream) {
  const dec = new StringDecoder("utf8"); // chunks may split multi-byte chars
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.write(chunk);
    let nl;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      yield line;
    }
  }
  rest += dec.end();
  if (rest) yield rest;
}

/**
 * Download (or read `source`, a local .jsonl[.gz] path or URL) Scryfall's
 * all_cards bulk file and upsert every paper printing. Streams with bounded
 * memory, commits in batches, removes printings that vanished upstream and
 * rebuilds the title search index. Options: onProgress({phase, count}),
 * signal, source, setsSource (array | path). Returns {printings, sets, ms}.
 */
export async function refreshIndex(idx, { onProgress, signal, source, setsSource, setsRetry } = {}) {
  const t0 = Date.now();
  onProgress?.({ phase: "sets", count: 0 });
  let sets = [];
  try {
    sets = await loadSets(setsSource, signal, setsRetry);
  } catch (e) {
    if (signal?.aborted) throw e;
    // /sets carries parent_set_code (promo lookups) and the printed set sizes
    // (1998-2014 "nnn/ttt"): never silently drop them. Keep the previous sets
    // table; without one, only an offline (local file) build may go on and
    // derive the sets from the printings.
    sets = idx.prepare("SELECT * FROM sets").all().map((r) => ({ ...r }));
    const offline = source && !/^https?:/.test(source);
    if (!sets.length && !offline) throw new Error(`Scryfall /sets failed (${e.message}); index not refreshed`);
    console.warn(`[cardindex] /sets failed (${e.message}); ${sets.length ? "keeping the previous set list" : "deriving sets from the printings"}`);
  }
  const setsByCode = new Map(sets.map((s) => [s.code, s]));

  const { stream, updatedAt } = await openBulk(source, signal);
  idx.exec("DROP TABLE IF EXISTS printings_new");
  idx.exec(printingsTable("printings_new"));
  const insert = idx.prepare(
    `INSERT OR REPLACE INTO printings_new (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`,
  );
  let count = 0;
  let skipped = 0;
  let inTx = false;
  try {
    for await (let line of jsonLines(stream)) {
      line = line.trim();
      if (line.endsWith(",")) line = line.slice(0, -1);
      if (!line || line === "[" || line === "]") continue;
      let c;
      try { c = JSON.parse(line); } catch { skipped++; continue; }
      if (c.object !== "card" || c.digital || (Array.isArray(c.games) && !c.games.includes("paper"))) { skipped++; continue; }
      if (!inTx) { idx.exec("BEGIN"); inTx = true; }
      const r = rowFromCard(c, setsByCode);
      insert.run(...COLS.map((k) => r[k]));
      count++;
      if (count % BATCH === 0) {
        idx.exec("COMMIT");
        inTx = false;
        onProgress?.({ phase: "printings", count });
        if (signal?.aborted) throw signal.reason || new Error("aborted");
        await new Promise((res) => setImmediate(res)); // let the server breathe
      }
    }
    if (inTx) { idx.exec("COMMIT"); inTx = false; }
  } catch (e) {
    if (inTx) idx.exec("ROLLBACK");
    idx.exec("DROP TABLE IF EXISTS printings_new");
    throw e;
  }
  if (count === 0) {
    idx.exec("DROP TABLE IF EXISTS printings_new");
    throw new Error("bulk file contained no printings");
  }

  onProgress?.({ phase: "finalize", count });
  idx.exec("BEGIN");
  try {
    idx.exec("DROP TABLE printings");
    idx.exec("ALTER TABLE printings_new RENAME TO printings");
    idx.exec(PRINTINGS_INDEXES);
    idx.exec("DELETE FROM sets");
    const insSet = idx.prepare(
      "INSERT OR REPLACE INTO sets(code, name, parent_set_code, set_type, released_at, card_count, printed_size) VALUES (?,?,?,?,?,?,?)",
    );
    for (const s of sets) {
      if (s.digital) continue;
      insSet.run(s.code, s.name || null, s.parent_set_code || null, s.set_type || null, s.released_at || null,
        s.card_count ?? null, s.printed_size ?? null);
    }
    // Sets missing from /sets (offline refresh): derive from the printings.
    idx.exec(`INSERT OR IGNORE INTO sets(code, name, parent_set_code, set_type, released_at, card_count)
      SELECT set_code, MAX(set_name), MAX(parent_set_code), MAX(set_type), MIN(released_at), COUNT(DISTINCT collector_number)
      FROM printings GROUP BY set_code`);
    rebuildTitles(idx);
    setMeta(idx, "last_refresh", new Date().toISOString());
    setMeta(idx, "bulk_updated_at", updatedAt);
    setMeta(idx, "printings", count);
    idx.exec("COMMIT");
  } catch (e) {
    idx.exec("ROLLBACK");
    idx.exec("DROP TABLE IF EXISTS printings_new");
    throw e;
  }
  // Names/oracle ids copied into the fingerprints follow the new printings.
  onProgress?.({ phase: "fingerprint_meta", count });
  await syncFingerprintMeta(idx, { all: true, signal });
  idx.exec("PRAGMA optimize");
  // The swap writes the whole table through the WAL; give the space back.
  try { idx.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* readers active: next checkpoint */ }
  const result = { printings: count, skipped, sets: idx.prepare("SELECT COUNT(*) n FROM sets").get().n, ms: Date.now() - t0 };
  onProgress?.({ phase: "done", count });
  return result;
}

/**
 * refreshIndex in a worker thread with its own connection to `file`, so the
 * multi-second finalize step (table swap, indexes, title search rebuild)
 * never blocks the server's event loop; WAL keeps readers going meanwhile.
 * Same options and result as refreshIndex.
 */
export function refreshIndexInWorker(file, { onProgress, signal, source, setsSource } = {}) {
  return runIndexWorker({ file, source, setsSource }, { onProgress, signal });
}

/**
 * Run one background index job in lib/index-worker.js (workerData.task:
 * 'refresh' default, 'fingerprints'); resolves with its result, forwards
 * progress, and asks the worker to stop (state 'paused') on `signal`.
 */
export function runIndexWorker(workerData, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const w = new Worker(new URL("./index-worker.js", import.meta.url), { workerData });
    let settled = false;
    const abort = () => w.postMessage("abort");
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (fn, v) => { if (!settled) { settled = true; signal?.removeEventListener("abort", abort); fn(v); } };
    w.on("message", (m) => {
      if (m?.type === "progress") onProgress?.(m.progress);
      else if (m?.type === "done") settle(resolve, m.result);
      else if (m?.type === "error") settle(reject, new Error(m.error));
    });
    w.on("error", (e) => settle(reject, e));
    w.on("exit", (code) => settle(reject, new Error(`index worker exited with code ${code}`)));
  });
}

function rebuildTitles(idx) {
  idx.exec("DELETE FROM titles");
  const ins = idx.prepare("INSERT INTO titles(text, lang, oracle_id, name, printed, printing_id) VALUES (?,?,?,?,?,?)");
  // Newest printing first so the representative printing_id is the latest one.
  const rows = idx.prepare(
    "SELECT id, oracle_id, name, printed_name, lang, faces FROM printings ORDER BY released_at DESC",
  );
  const seen = new Set();
  const add = (title, lang, oracle, name, id) => {
    const text = normTitle(title);
    if (!text) return;
    const k = `${text}\u0000${lang}\u0000${oracle}`;
    if (seen.has(k)) return;
    seen.add(k);
    ins.run(text, lang, oracle, name, title, id);
  };
  for (const r of rows.iterate()) {
    const faces = r.faces ? JSON.parse(r.faces) : [];
    if (r.lang === "en" || !r.printed_name) add(r.name, r.lang === "en" ? "en" : r.lang, r.oracle_id, r.name, r.id);
    if (r.printed_name) add(r.printed_name, r.lang, r.oracle_id, r.name, r.id);
    // Title OCR reads one face; index each face's name on its own as well.
    if (faces.length > 1) {
      for (const f of faces) {
        if (r.lang === "en" || !f.printed_name) add(f.name, r.lang, r.oracle_id, r.name, r.id);
        if (f.printed_name) add(f.printed_name, r.lang, r.oracle_id, r.name, r.id);
      }
    }
  }
  if (trigramFts) {
    idx.exec("INSERT INTO titles_fts(titles_fts) VALUES ('rebuild')");
  } else {
    idx.exec("DELETE FROM title_grams");
    const g = idx.prepare("INSERT INTO title_grams(gram, title_id) VALUES (?, ?)");
    for (const t of idx.prepare("SELECT id, text FROM titles").iterate()) {
      for (const gram of new Set(trigrams(t.text))) g.run(gram, t.id);
    }
  }
}

function trigrams(s) {
  const out = [];
  const chars = [...s];
  for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(""));
  return out;
}

const JSON_COLS = ["finishes", "promo_types", "frame_effects", "faces"];
function toPrinting(r) {
  if (!r) return null;
  const p = { ...r };
  for (const k of JSON_COLS) p[k] = r[k] ? JSON.parse(r[k]) : k === "faces" ? [] : [];
  p.full_art = !!r.full_art;
  return p;
}
const many = (rows) => rows.map(toPrinting);

/** One printing by Scryfall id (JSON columns parsed), or null. */
export function getPrinting(idx, id) {
  return toPrinting(idx.prepare("SELECT * FROM printings WHERE id = ?").get(id));
}

// Plain set code printed on the card's collector line for a printing.
function lineSet(p) {
  if (p.set_code === "plst") {
    const m = /^([A-Za-z0-9]+)-\d+/.exec(p.collector_number);
    if (m) return m[1].toLowerCase();
  }
  return p.parent_set_code && /^p/.test(p.set_code) ? p.parent_set_code : p.set_code;
}

// Ranking for collector-line hits: the exact set first, plain numbers before
// suffixed ones (prerelease 's', promo 'p', '★'), main sets before promos.
function rankCollector(set, n) {
  const tier = (p) => (p.set_code === set ? 0 : p.set_code === `p${set}` ? 1 : p.set_code === "plst" ? 2 : 3);
  return (a, b) => {
    const score = (p) => tier(p) * 2 + (p.collector_number === String(n) ? 0 : 1);
    return score(a) - score(b) || String(b.released_at).localeCompare(String(a.released_at)) || a.lang.localeCompare(b.lang);
  };
}

/**
 * Printings whose printed collector line reads SET + NUMBER (+ LANG): matches
 * set_code or parent_set_code on the digits of the number (suffixes ignored)
 * and The List rows numbered "SET-N". `lang` is a Scryfall language code.
 */
export function lookupCollector(idx, { set, number, lang } = {}) {
  const code = String(set || "").trim().toLowerCase();
  const n = cnDigits(number);
  if (!code || n == null) return [];
  const langSql = lang ? " AND lang = ?" : "";
  const args = lang ? [lang] : [];
  const rows = idx.prepare(
    `SELECT * FROM printings WHERE set_code = ? AND cn_digits = ?${langSql}
     UNION SELECT * FROM printings WHERE parent_set_code = ? AND cn_digits = ?${langSql}
     UNION SELECT * FROM printings WHERE set_code = 'plst' AND cn_digits = ? AND collector_number LIKE ?${langSql}`,
  ).all(code, n, ...args, code, n, ...args, n, `${code.toUpperCase()}-%`, ...args);
  return many(rows).filter((p) => p.set_code !== "plst" || lineSet(p) === code).sort(rankCollector(code, n));
}

/**
 * 1998–2014 cards print only "nnn/ttt". Returns printings with that number in
 * sets whose printed size (or card count) is close to `total`, best set-size
 * fit first. Sets without printed_size match on card_count ±5%. Only sets
 * released in the "nnn/ttt" era (Exodus 1998 – before M15 2014) unless
 * `anyEra` is set.
 */
export function lookupLegacyNumber(idx, { number, total, lang, anyEra = false } = {}) {
  const n = cnDigits(number);
  const t = parseInt(total, 10);
  if (n == null || !Number.isFinite(t) || t <= 0 || n > t + 20) return [];
  const slack = Math.max(2, Math.round(t * 0.05));
  const rows = idx.prepare(
    `SELECT p.*, s.printed_size AS s_printed, s.card_count AS s_count FROM printings p JOIN sets s ON s.code = p.set_code
     WHERE p.cn_digits = ? AND p.collector_number GLOB '[0-9]*' AND p.collector_number NOT GLOB '*[^0-9]*'
       AND (s.printed_size = ? OR (s.printed_size IS NULL AND s.card_count BETWEEN ? AND ?))
       ${anyEra ? "" : `AND s.released_at >= '${LEGACY_FROM}' AND s.released_at < '${LEGACY_TO}'`}${lang ? " AND p.lang = ?" : ""}`,
  ).all(n, t, t - slack, t + slack, ...(lang ? [lang] : []));
  const fit = (r) => (r.s_printed === t ? 0 : 1 + Math.abs((r.s_count ?? 0) - t));
  rows.sort((a, b) => fit(a) - fit(b) || String(a.released_at).localeCompare(String(b.released_at)));
  return rows.map(({ s_printed, s_count, ...r }) => {
    const p = toPrinting(r);
    p.size_match = s_printed === t ? "printed_size" : "card_count";
    return p;
  });
}

const LEGACY_FROM = "1998-06-01"; // Exodus: first printed collector numbers
const LEGACY_TO = "2014-07-18"; // M15: set + language codes on the line

function levRatio(a, b) {
  const A = [...a], B = [...b];
  if (!A.length || !B.length) return 0;
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[B.length] / Math.max(A.length, B.length);
}

/**
 * Fuzzy title lookup (OCR-noise tolerant) over English names and localized
 * printed names. Returns [{id, oracle_id, name, printed_name, lang, score}]
 * with score in 0..1 (normalised Levenshtein similarity), best first.
 */
export function searchTitle(idx, text, { lang, limit = 10 } = {}) {
  const q = normTitle(text);
  if (!q) return [];
  const grams = [...new Set(trigrams(q))];
  let rows;
  const langSql = lang ? " AND t.lang = ?" : "";
  const langArgs = lang ? [lang] : [];
  if (!grams.length) {
    rows = idx.prepare(`SELECT t.* FROM titles t WHERE t.text LIKE ?${langSql} LIMIT 200`).all(`${q}%`, ...langArgs);
  } else if (trigramFts) {
    const match = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(" OR ");
    rows = idx.prepare(
      `SELECT t.* FROM titles_fts f JOIN titles t ON t.id = f.rowid
       WHERE titles_fts MATCH ?${langSql} ORDER BY bm25(titles_fts) LIMIT 300`,
    ).all(match, ...langArgs);
  } else {
    rows = idx.prepare(
      `SELECT t.*, COUNT(*) hits FROM title_grams g JOIN titles t ON t.id = g.title_id
       WHERE g.gram IN (${grams.map(() => "?").join(",")})${langSql} GROUP BY t.id ORDER BY hits DESC LIMIT 300`,
    ).all(...grams, ...langArgs);
  }
  const best = new Map();
  for (const r of rows) {
    const score = levRatio(q, r.text);
    const k = `${r.oracle_id}\u0000${r.lang}`;
    if (!best.has(k) || best.get(k).score < score) {
      best.set(k, { id: r.printing_id, oracle_id: r.oracle_id, name: r.name, printed_name: r.printed, lang: r.lang, score: +score.toFixed(4) });
    }
  }
  // Ties: a card whose whole name is the title ("Lightning Bolt") beats one
  // where it is only a face ("Emeritus of Conflict // Lightning Bolt", art cards).
  const whole = (h) => (normTitle(h.name) === q || normTitle(h.printed_name || "") === q ? 0 : 1);
  return [...best.values()].sort((a, b) => b.score - a.score || whole(a) - whole(b)).slice(0, limit);
}

/** All printings of an oracle card (optionally one language), newest first. */
export function printingsOf(idx, oracleId, { lang } = {}) {
  return many(idx.prepare(
    `SELECT * FROM printings WHERE oracle_id = ?${lang ? " AND lang = ?" : ""} ORDER BY released_at DESC, set_code, cn_digits`,
  ).all(oracleId, ...(lang ? [lang] : [])));
}

/**
 * Printed names of cards in one language: {oracle_id: printed_name} for the
 * oracle ids that have a printing in `lang` with a printed name (the newest
 * one; double-faced names are joined with " // " at ingest). Ids without one
 * are left out. Runs in the matcher worker (INDEX_OPS): the build list shows
 * the German name next to the English one.
 */
export function localizedNames(idx, oracleIds = [], lang = "de") {
  const q = idx.prepare(
    "SELECT printed_name FROM printings WHERE oracle_id = ? AND lang = ? AND printed_name IS NOT NULL ORDER BY released_at DESC LIMIT 1",
  );
  const out = {};
  for (const id of new Set(oracleIds)) {
    if (typeof id !== "string" || !id) continue;
    const r = q.get(id, String(lang));
    if (r?.printed_name) out[id] = r.printed_name;
  }
  return out;
}

/**
 * Same-line twins of a printing: same name and number digits in the same
 * language across the printed set's family (parent set, its promo children,
 * The List "SET-N"), excluding the printing itself. Base printings first.
 */
export function variantsOf(idx, printing) {
  if (!printing) return [];
  const code = lineSet(printing);
  const n = printing.cn_digits ?? cnDigits(printing.collector_number);
  if (n == null) return [];
  return lookupCollector(idx, { set: code, number: n, lang: printing.lang })
    .filter((p) => p.id !== printing.id && p.oracle_id === printing.oracle_id);
}

/** Storage-language setting that keeps the detected printing and its language. */
export const STORE_AS_SCANNED = "scanned";

/**
 * The printing to store for a detected printing: same set + collector number
 * in `storageLang`, else the English one, else the input itself.
 * `storageLang` STORE_AS_SCANNED ('scanned') returns the input itself.
 */
export function storagePrinting(idx, printing, storageLang = "en") {
  if (!printing) return null;
  // "As scanned" (the default since v0.5.0): the collection keeps the detected printing.
  if (printing.lang === storageLang || storageLang === STORE_AS_SCANNED) return printing;
  // cn_digits keeps this on the (set_code, cn_digits, lang) index; set_code
  // alone scanned the whole set (>1 s on a cold cache).
  const n = printing.cn_digits ?? cnDigits(printing.collector_number);
  const q = idx.prepare("SELECT * FROM printings WHERE set_code = ? AND cn_digits IS ? AND lang = ? AND collector_number = ?");
  return toPrinting(q.get(printing.set_code, n, storageLang, printing.collector_number))
    || (printing.lang === "en" ? null : toPrinting(q.get(printing.set_code, n, "en", printing.collector_number)))
    || printing;
}

/** Known set codes (lowercase), e.g. for OCR set-code matching. */
export function setCodes(idx) {
  return idx.prepare("SELECT code FROM sets ORDER BY code").all().map((r) => r.code);
}

/** {printings, sets, last_refresh, bulk_updated_at, fingerprints, fingerprint_job}. */
/**
 * indexStatus without the COUNT(*)s, for the server's main thread (startup
 * auto build, scheduler): `printings` is 1/0 (any row?), no counts. The
 * counts scan whole tables: seconds on a cold cache.
 */
export function indexBrief(idx) {
  let job = null;
  try { job = JSON.parse(getMeta(idx, "fingerprint_job") || "null"); } catch { job = null; }
  return {
    printings: idx.prepare("SELECT EXISTS (SELECT 1 FROM printings) n").get().n,
    last_refresh: getMeta(idx, "last_refresh"),
    bulk_updated_at: getMeta(idx, "bulk_updated_at"),
    fingerprint_job: job,
  };
}

export function indexStatus(idx) {
  const n = (sql) => idx.prepare(sql).get().n;
  let job = null;
  try { job = JSON.parse(getMeta(idx, "fingerprint_job") || "null"); } catch { job = null; }
  return {
    printings: n("SELECT COUNT(*) n FROM printings"),
    sets: n("SELECT COUNT(*) n FROM sets"),
    last_refresh: getMeta(idx, "last_refresh"),
    bulk_updated_at: getMeta(idx, "bulk_updated_at"),
    fingerprints: n("SELECT COUNT(*) n FROM fingerprints"),
    fingerprint_job: job,
  };
}

// --- Set completion (Binders → Sets) -----------------------------------------
// Completion counts distinct CARDS (oracle ids) of a set, in any printing or language: a borderless
// or showcase variant of a card you own doesn't count as missing (Scryfall's printed_size is empty
// for most modern sets, so "the main set" can't be told apart reliably). Tokens, emblems and art
// cards are left out. Prices: the cheapest English EUR printing of the card in that set.

const NOT_A_CARD = new Set(["token", "double_faced_token", "emblem", "art_series"]);

/**
 * The set's cards in ONE pass over its rows (printings_set_cn): [{oracle_id, name, eur, printings, id,
 * rarity, image_small, collector_number, cn_digits}], one per oracle id. English rows decide the card
 * list and the price (cheapest English printing; its id/number/image are the card's), a set without
 * English rows uses every language.
 */
function setCards(idx, code) {
  const rows = idx.prepare(
    `SELECT id, oracle_id, name, lang, eur, rarity, image_small, collector_number, cn_digits, layout
       FROM printings WHERE set_code = ? AND oracle_id IS NOT NULL`,
  ).all(code);
  const hasEn = rows.some((r) => r.lang === "en");
  const by = new Map();
  for (const r of rows) {
    if (NOT_A_CARD.has(r.layout ?? "") || (hasEn && r.lang !== "en")) continue;
    let c = by.get(r.oracle_id);
    if (!c) { c = { oracle_id: r.oracle_id, name: r.name, numbers: new Set(), best: r }; by.set(r.oracle_id, c); }
    c.numbers.add(r.collector_number);
    const b = c.best;
    // cheapest priced printing; ties and unpriced ones: the lowest number
    const better = (r.eur != null && (b.eur == null || r.eur < b.eur))
      || ((r.eur ?? null) === (b.eur ?? null) && ((r.cn_digits ?? 1e9) < (b.cn_digits ?? 1e9)));
    if (better) c.best = r;
  }
  return [...by.values()].map(({ oracle_id, name, numbers, best }) => ({
    oracle_id, name, eur: best.eur ?? null, printings: numbers.size, id: best.id, rarity: best.rarity ?? null,
    image_small: best.image_small ?? null, collector_number: best.collector_number ?? null, cn_digits: best.cn_digits ?? null,
  }));
}

const setRow = (idx, code) => idx.prepare("SELECT code, name, parent_set_code, set_type, released_at, card_count, printed_size FROM sets WHERE code = ?").get(code);

/**
 * Completion per set for the owned oracle ids: owned = {set_code: [oracle_id, ...]}. Returns
 * [{code, name, set_type, parent_set_code, released_at, cards, owned, missing, missing_eur, unpriced}]
 * for the sets the index knows (others are left out). Runs in the matcher worker (INDEX_OPS).
 */
export function setCompletion(idx, owned = {}) {
  const out = [];
  for (const [code, ids] of Object.entries(owned)) {
    const set = setRow(idx, String(code).toLowerCase());
    if (!set) continue;
    const have = new Set(ids);
    let n = 0, got = 0, missingEur = 0, unpriced = 0;
    for (const c of setCards(idx, set.code)) {
      n++;
      if (have.has(c.oracle_id)) { got++; continue; }
      if (c.eur == null) unpriced++; else missingEur += c.eur;
    }
    if (!n) continue;
    out.push({
      code: set.code, name: set.name, set_type: set.set_type, parent_set_code: set.parent_set_code, released_at: set.released_at,
      cards: n, owned: got, missing: n - got, missing_eur: Math.round(missingEur * 100) / 100, unpriced,
    });
  }
  return out;
}

/**
 * One set's checklist: {set, cards: [{oracle_id, name, rarity, eur, id, image_small, collector_number,
 * printings}]} sorted by collector number (cheapest English printing's), or null for an unknown set.
 */
export function setChecklist(idx, code) {
  const set = setRow(idx, String(code).toLowerCase());
  if (!set) return null;
  const cards = setCards(idx, set.code);
  cards.sort((a, b) => (a.cn_digits ?? 1e9) - (b.cn_digits ?? 1e9) || String(a.collector_number).localeCompare(String(b.collector_number)) || a.name.localeCompare(b.name));
  return { set: { ...set }, cards: cards.map(({ cn_digits: _c, ...c }) => c) };
}
