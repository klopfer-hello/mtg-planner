// mtg-planner web server: JSON API, ManaBox CSV import, decks, Claude chat
// (Server-Sent Events), the card scanner (identify + staging + commit, local
// card index jobs), manual backup/restore of the app database, the wishlist,
// the value history (Value tab) and the static single-page app. Node stdlib only.
//
// Unauthenticated by design: meant for a trusted LAN (see docs/backups-and-security.md).

import http from "node:http";
import crypto from "node:crypto";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { SCHEMA_VERSION, cardPrice, getAppMeta, openDb, setAppMeta, stats } from "./lib/db.js";
import { QUERY_HELP, searchCollection } from "./lib/query.js";
import { CARD_FACTS_META, IMPORT_MODES, backfillCardFacts, cardFactsPending, importManaBoxCsv, refreshOwnedCards } from "./lib/manabox.js";
import { syncEnglishPrices } from "./lib/prices.js";
import {
  DECK_STATUSES, DeckError, bracketVerdict, cardUsage, deckComboRequest, deckDetail, deckPower, draftDeck, eurForFinish, exportDeck, listDecks,
  normalizeFormat, parseDecklist, saveDeck, setCommander, shoppingList, updateDeckCard,
} from "./lib/decks.js";
import {
  SpellbookError, backoffUntil, createSpellbookScheduler, pruneSpellbookCache, seedSpellbookSettings, setSpellbookSettings, spellbookHealth, spellbookOptedOut,
  spellbookSettings,
} from "./lib/spellbook.js";
import * as claudeLib from "./lib/claude.js";
import { MAX_CONCURRENT, activeClaudeRuns, claudeConfigured, killAll, prepareMcpConfig, runTurn, runVision, visionCap } from "./lib/claude.js";
import {
  checkpointIndex, fetchBulkInfo, getMeta, indexBrief, openIndex, refreshIndex, refreshIndexInWorker, setMeta,
} from "./lib/cardindex.js";
import * as indexModule from "./lib/cardindex.js";
import { createScheduler, schedulerConfig } from "./lib/scheduler.js";
import { Matcher, MatcherWorker, buildFingerprints, buildFingerprintsInWorker, checkJpegSize } from "./lib/fingerprint.js";
import { ocrHelperStatus, ocrTools } from "./lib/ocr.js";
import { decideFinish, identifyOriented, printingSummary, scanPriceEur } from "./lib/scanner.js";
import { DebugError, DebugSessions } from "./lib/debugsessions.js";
import { DebugPerf, PerfError } from "./lib/debugperf.js";
import { APK_TYPE, DownloadError, defaultDownloadDir, downloadPath, listDownloads } from "./lib/downloads.js";
import {
  BackupError, backupConfig, backupPath, createBackup, dbCounts, deleteBackup, gunzipToFile, listBackups, swapDatabase, validateBackupDb,
} from "./lib/backups.js";
import {
  CONDITIONS, LABEL_SOURCES, PROBE_SESSION_RE, ProbeRunner, ScanError, probeKey, captureLog, commitScans, createScanSlots, defaultImageDir, normFinish,
  deleteScan, exportCalibration, getScan, incrementScan, listScans, priceScans, recordTruth, scanImagePath, scanStripPath, stageScan, undoLast,
  updateScan,
} from "./lib/scans.js";
import { learningReport } from "./lib/learning.js";
import {
  BinderError, MAX_BINDER_NAME, collectionMaster, createBinder, deckToBinder, defaultImportMode, deleteBinder, findBinder, listBinders,
  moveCopies, renameBinder, setCollectionMaster,
} from "./lib/binders.js";
import { deleteCopies, editCopies, listEdits, relanguageScans, undoEdit } from "./lib/edits.js";
import { cardHistory, ensureSnapshot, financeHistory, financeMovers, financeSummary, financeTop, snapshotValue } from "./lib/finance.js";
import { WishlistError, addWishlistItem, deleteWishlistItem, getWishlistItem, listWishlist, updateWishlistItem, wishlistShopping } from "./lib/wishlist.js";

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "/app/public");
const VERSION = process.env.APP_VERSION || "dev";
const JSON_LIMIT = 1024 * 1024;
const CSV_LIMIT = 25 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20000;
const SCAN_LIMIT = 12 * 1024 * 1024;
// /increment body ({capture}): the record is cut to 4 KB by sanitizeCapture;
// the raw body may be a bit larger (a chip record with its evidence).
const INCREMENT_LIMIT = 16 * 1024;
// Record session frame upload: ≤ 300 KB JPEG as base64 plus a decision record.
const DEBUG_FRAME_LIMIT = 512 * 1024;
// Scanner perf beacon (lib/debugperf.js caps the stored entry at 4 KB).
const DEBUG_PERF_LIMIT = 16 * 1024;
const SCAN_MAX_CONCURRENT = Math.max(1, Number(process.env.SCAN_MAX_CONCURRENT) || 2);
// "scanned" (indexModule.STORE_AS_SCANNED, the default): keep the detected printing and its language.
const STORAGE_LANGS = [indexModule.STORE_AS_SCANNED, "en", "de", "fr", "it", "es", "pt", "ja", "ko", "ru", "zhs", "zht"];
const INDEX_FILE = process.env.INDEX_DB_FILE || "/data/cardindex.db";
// Declared JPEG size caps for uploads (djpeg writes the full declared raster).
const MAX_CARD_PIXELS = 6_000_000; // the browser sends 1000x1400
const MAX_STRIP_PIXELS = 20_000_000;
// How long a scan waits for the fingerprint matcher's warm-up before it goes
// on without the fingerprint (OCR / Claude only).
const SCAN_MATCHER_WAIT_MS = Number(process.env.SCAN_MATCHER_WAIT_MS) >= 0 && process.env.SCAN_MATCHER_WAIT_MS !== ""
  ? Number(process.env.SCAN_MATCHER_WAIT_MS) : 30000;

const DB_FILE = path.resolve(process.env.DB_FILE || "/data/mtg-planner.db");
const BACKUP = backupConfig();
const BACKUP_UPLOAD_LIMIT = 50 * 1024 * 1024;
const DOWNLOAD_DIR = defaultDownloadDir();

// `let`: a restore (lib/backups.js swapDatabase) closes and reopens it; every
// user below reads the binding at call time.
let db = openDb(DB_FILE);

// The scanner's card index lives in its own SQLite file; the app keeps
// working (minus scanning) if it can't be opened.
let idx = null;
let matcher = null;
try {
  idx = openIndex(INDEX_FILE);
  // Fingerprint loading/hashing/matching run in a worker thread (started
  // after listen); an in-memory index (tests) can only match in-process.
  matcher = INDEX_FILE === ":memory:" ? new Matcher(idx) : new MatcherWorker(INDEX_FILE, { waitMs: SCAN_MATCHER_WAIT_MS });
  // The hourly Claude vision cap survives restarts (best effort).
  try { visionCap.restore(JSON.parse(getMeta(idx, "vision_calls") || "[]")); } catch { /* fresh window */ }
  // Skipped while the refresh worker holds the index's write lock (a busy wait would block the event loop).
  visionCap.persistWith((stamps) => { if (indexJob.running?.kind !== "refresh") setMeta(idx, "vision_calls", JSON.stringify(stamps)); });
} catch (err) {
  console.warn(`[scanner] card index unavailable: ${err.message}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra; // more JSON fields for the error body (e.g. {code})
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' cdnjs.cloudflare.com 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' data: https://cards.scryfall.io https://svgs.scryfall.io",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status);
  res.end();
}

/** "16 KB" / "12 MB" for a byte limit (413 messages). */
const sizeLabel = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${Math.round(n / 1024 / 1024)} MB`);

/** Read the request body as a Buffer, rejecting with 413 above `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, `Request body too large (max ${sizeLabel(limit)})`));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `Request body too large (max ${sizeLabel(limit)})`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!failed) { failed = true; reject(err); } });
  });
}

async function readJson(req, limit = JSON_LIMIT) {
  requireContentType(req, "application/json");
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let body;
  try { body = JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON body must be an object");
  return body;
}

const optString = (v, field, max = 2000) => {
  if (v == null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
};

const parseJsonField = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// ---------------------------------------------------------------------------
// Collection & cards

function collectionRows(query) {
  const group = query.get("group") === "printing" ? "printing" : "card";
  const limit = Math.min(Math.max(parseInt(query.get("limit"), 10) || 60, 1), 500);
  const offset = Math.max(parseInt(query.get("offset"), 10) || 0, 0);
  const dir = query.get("dir") === "asc" || query.get("dir") === "desc" ? query.get("dir") : undefined;
  let result;
  try {
    const binder = query.has("binder") ? query.get("binder").slice(0, 200) : null;
    result = searchCollection(db, { q: query.get("q") || "", group, sort: query.get("sort") || "name", dir, limit, offset, binder });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  for (const row of result.rows) {
    row.prices = parseJsonField(row.prices, {});
    // Price of the row's representative (most valuable) owned printing+finish.
    row.price = cardPrice(row, row.finish || "normal");
  }
  return result;
}

function cardDetail(id) {
  const card = db.prepare("SELECT * FROM cards WHERE scryfall_id = ?").get(id);
  if (!card) throw new HttpError(404, "Card not found");
  card.prices = parseJsonField(card.prices, {});
  card.legalities = parseJsonField(card.legalities, {});
  card.keywords = parseJsonField(card.keywords, []);
  card.price = cardPrice(card);
  const owned = db.prepare(
    `SELECT col.id, c.scryfall_id, c.set_code, c.set_name, c.collector_number, col.finish, col.language,
            col.condition, col.binder, col.source, col.quantity, c.image_small, c.prices
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id = ?
      ORDER BY c.set_code, c.collector_number, col.finish, col.binder COLLATE NOCASE, col.source`,
  ).all(card.oracle_id).map(({ prices, ...r }) => ({ ...r, price_eur: eurForFinish(prices, r.finish) })); // EUR per copy (English twin fallback)
  const decks = db.prepare(
    `SELECT d.id, d.name, d.status, dc.board, SUM(dc.quantity) AS quantity
       FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
       LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE c.oracle_id = ? OR (dc.scryfall_id IS NULL AND dc.name = ? COLLATE NOCASE)
      GROUP BY d.id, dc.board
      ORDER BY d.updated_at DESC`,
  ).all(card.oracle_id, card.name);
  return { card, owned, decks, usage: cardUsage(db, { oracle_id: card.oracle_id, name: card.name }) };
}

// ---------------------------------------------------------------------------
// Imports (one at a time: they hit Scryfall and rewrite the collection)

let importBusy = false;

async function exclusive(fn) {
  if (importBusy) throw new HttpError(409, "Another import or price refresh is running");
  importBusy = true;
  try { return await fn(); } finally { importBusy = false; scheduleEnglishPrices(); }
}

// Foreign printings are valued at their English twin's EUR price when they
// have none (lib/prices.js): the twin prices are copied into the card rows
// after every collection write (exclusive), index job, chat turn (Claude can
// edit copies) and at boot. Debounced, in the background, one batched index
// call through the matcher worker; skipped while a write or restore runs.
let englishPricesTimer = null;
let englishPricesRunning = false;
function scheduleEnglishPrices(delay = 1000) {
  if (shuttingDown) return;
  clearTimeout(englishPricesTimer);
  englishPricesTimer = setTimeout(runEnglishPrices, delay);
  englishPricesTimer.unref?.();
}
async function runEnglishPrices() {
  if (shuttingDown) return;
  if (importBusy || restoring || englishPricesRunning) return scheduleEnglishPrices(5000);
  englishPricesRunning = true;
  try {
    const conn = db;
    const r = await syncEnglishPrices(conn, { indexPrices: idx ? (items) => indexLookup("printingPricesEur", items) : null });
    if (r.updated) console.log(`[prices] English twin prices: ${r.updated} of ${r.checked} foreign printings updated${r.index ? "" : " (cards table only)"}`);
  } catch (err) {
    console.warn(`[prices] English twin prices: ${err.message}`);
  } finally {
    englishPricesRunning = false;
    scheduleSnapshot(); // values follow the (twin) prices
  }
}

// Value history (lib/finance.js): today's snapshot is rewritten after every
// collection write (via the English price sync above, which every exclusive()
// write, chat turn, index job and restore triggers), after wishlist changes and
// by the nightly scheduler; seeded at boot. Debounced, never during an import
// or a restore; one grouped query + one transaction (~10-50 ms for a few
// thousand printings).
let snapshotTimer = null;
function scheduleSnapshot(delay = 1500) {
  if (shuttingDown) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(runSnapshot, delay);
  snapshotTimer.unref?.();
}
function runSnapshot() {
  if (shuttingDown) return;
  if (importBusy || restoring) return scheduleSnapshot(5000);
  try { snapshotValue(db); } catch (err) { console.warn(`[finance] snapshot: ${err.message}`); }
}

// v9 card facts (game_changer, produced_mana, layout) for owned and deck cards
// that were fetched before migration v9: one /cards/collection request per chunk
// (outside the lock), then only its write through exclusive() (a busy import →
// 409 → retry later; a running restore → retry later), after boot and after
// a restore. Never on a request path; off with the scheduler (SCHEDULER_ENABLED=false).
let cardFactsTimer = null;
let cardFactsRunning = false;
const CARD_FACTS_RETRY_MS = 60_000;
function scheduleCardFacts(delay = 5000) {
  if (shuttingDown || !schedulerConfig().enabled) return;
  clearTimeout(cardFactsTimer);
  cardFactsTimer = setTimeout(runCardFacts, delay);
  cardFactsTimer.unref?.();
}
async function runCardFacts() {
  if (shuttingDown) return;
  if (restoring || cardFactsRunning) return scheduleCardFacts(CARD_FACTS_RETRY_MS);
  cardFactsRunning = true;
  try {
    if (!cardFactsPending(db).length && getAppMeta(db, CARD_FACTS_META)) return;
    const r = await backfillCardFacts(() => db, {
      runChunk: (fn) => {
        if (restoring) throw new HttpError(503, "restore running");
        return exclusive(fn);
      },
    });
    if (r.refreshed || r.skipped) console.log(`[cards] v9 card facts: ${r.refreshed} refreshed, ${r.skipped} without a Game Changer flag`);
  } catch (err) {
    console.warn(`[cards] v9 card facts: ${err.message}; retrying in ${CARD_FACTS_RETRY_MS / 1000} s`);
    cardFactsRunning = false;
    return scheduleCardFacts(CARD_FACTS_RETRY_MS);
  } finally {
    cardFactsRunning = false;
  }
}

/** /healthz card_facts: the v9 backfill's meta {done_at, refreshed, skipped (count)} or null while not done. */
function cardFactsHealth() {
  try {
    const m = JSON.parse(getAppMeta(db, CARD_FACTS_META) || "null");
    return m ? { done_at: m.done_at ?? null, refreshed: m.refreshed ?? 0, skipped: Array.isArray(m.skipped) ? m.skipped.length : 0 } : null;
  } catch {
    return null;
  }
}

/** /healthz spellbook (never fails the health check). */
function spellbookHealthz() {
  try {
    return { ...spellbookHealth(db), queued: spellbook.pending().length };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Scryfall outages/network errors become 502; a Scryfall 4xx (it rejected
 * something from the user's file) and everything else (bad CSV) become 400.
 */
function importError(err) {
  if (err instanceof HttpError) return err;
  if (err.status >= 400 && err.status < 500 && err.status !== 429) return new HttpError(400, `Scryfall rejected the request: ${err.message}`);
  // scryfall() sets err.status; fetch() network failures are TypeErrors with a cause.
  if (err.status || (err instanceof TypeError && err.cause)) return new HttpError(502, `Scryfall request failed: ${err.message}`);
  return new HttpError(400, err.message);
}

// ---------------------------------------------------------------------------
// Decks

function getDeckOr404(id) {
  const detail = deckDetail(db, id);
  if (!detail) throw new HttpError(404, "Deck not found");
  for (const c of detail.cards) c.prices = parseJsonField(c.prices, null);
  // Missing or stale combos: fetch in the background (the UI re-reads once after a few seconds).
  if (detail.combos?.needs_fetch && detail.spellbook_request) spellbook.ensure(detail.spellbook_request);
  return detail;
}

// Commander Spellbook (lib/spellbook.js): combos for the bracket and score.
// Deck reads only look at the cache; this scheduler fills it in the background,
// never inside exclusive() (a fetch must not 409 imports and moves) and never
// while a restore swaps the DB (every write goes to the db current at write time).
const spellbook = createSpellbookScheduler({
  db: () => db,
  restoring: () => restoring,
  version: VERSION,
  log: console,
  requestFor: (conn, deckId) => deckComboRequest(conn, deckId),
});

/** Refresh the combos of a deck a few seconds after a write (debounced per deck; a cache hit makes no call). */
function scheduleSpellbook(deckId) {
  if (!shuttingDown && deckId) spellbook.schedule(Number(deckId));
}

/** SQLite's datetime('now'): decks.updated_at uses it, so "decks changed since" works across a write. */
const sqlNow = () => db.prepare("SELECT datetime('now') AS t").get().t;

/** Schedule the combos of every deck written since `since` (imports, scan commits, chat turns). */
function scheduleChangedDecks(since) {
  try {
    for (const { id } of db.prepare("SELECT id FROM decks WHERE updated_at >= ?").all(since)) scheduleSpellbook(id);
  } catch (err) {
    console.warn(`[spellbook] ${err.message}`);
  }
}

/** Optional bracket_declared from a body: undefined = not given, null = auto, 1-5. */
function bracketDeclared(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, "bracket_declared must be 1-5 or null (auto)");
  return v;
}

/** POST /api/decks/:id/combos: refetch the deck's combos now (202), refused while backing off / disabled. */
function postDeckCombos(id) {
  if (!db.prepare("SELECT 1 FROM decks WHERE id = ?").get(id)) throw new HttpError(404, "Deck not found");
  const settings = spellbookSettings(db);
  if (!settings.enabled) {
    throw new HttpError(503, settings.env_disabled ? "The combo check is turned off (SPELLBOOK_ENABLED=false)" : "The combo check is turned off in Settings");
  }
  const request = deckComboRequest(db, id);
  if (!request) throw new HttpError(400, "Combos are only checked for Commander decks");
  const until = backoffUntil(db);
  if (until > Date.now()) {
    throw new HttpError(409, "The combo check is paused (Commander Spellbook was unreachable or asked us to wait); try again later", { retry_at: new Date(until).toISOString() });
  }
  spellbook.refresh(request);
  return { status: "pending", deck_id: id };
}

/**
 * POST /api/decks/evaluate {text, format?, commander?, target_bracket?}: stats and power of a
 * decklist without saving it. Waits up to 8 s for the combos, else answers with them pending.
 */
async function evaluateDeck(req) {
  const body = await readJson(req);
  const text = optString(body.text, "text", 200000) || "";
  const format = normalizeFormat(optString(body.format, "format", 50));
  const commander = Array.isArray(body.commander)
    ? body.commander.slice(0, 4).map((c, i) => optString(c, `commander[${i}]`, 300)).filter(Boolean)
    : optString(body.commander, "commander", 300) || null;
  const target = body.target_bracket == null ? null : bracketDeclared(body.target_bracket);
  if (!parseDecklist(text).items.length) throw new HttpError(400, "The decklist is empty");
  let draft;
  try {
    draft = await draftDeck(db, { text, format, commander });
  } catch (err) {
    throw importError(err);
  }
  const combos = draft.request ? await spellbook.evaluate(draft.request, { waitMs: 8000 }) : undefined;
  const p = deckPower(db, draft.deck, draft.rows, { combos });
  return {
    stats: p.stats, power: p.power, combos: p.combos, unresolved: draft.unresolved, parse_errors: draft.parse_errors,
    ...(target != null ? { verdict: bracketVerdict(p.power, target) } : {}),
  };
}

/** Settings fields of the combo check (GET/PATCH /api/settings). */
function spellbookSettingsView() {
  const s = spellbookSettings(db);
  return { spellbook_enabled: s.enabled, spellbook: { enabled: s.enabled, env_disabled: s.env_disabled, url: s.url } };
}

async function createDeck(req) {
  const body = await readJson(req);
  const name = optString(body.name, "name", 200);
  if (!name) throw new HttpError(400, "name is required");
  const text = optString(body.text, "text", 200000) || "";
  const { items, errors } = parseDecklist(text);
  if (items.length === 0) throw new HttpError(400, errors.length ? `No cards recognised (e.g. "${errors[0]}")` : "The decklist is empty");
  let saved;
  try {
    saved = await saveDeck(db, {
      name,
      format: normalizeFormat(optString(body.format, "format", 50)),
      description: optString(body.description, "description", 5000) || null,
      source: "manual",
      status: deckStatus(body.status),
      items,
    });
  } catch (err) {
    if (err instanceof DeckError) throw new HttpError(err.status, err.message);
    throw importError(err);
  }
  scheduleSpellbook(saved.id);
  return { id: saved.id, unresolved: saved.unresolved, parse_errors: errors };
}

/** Optional deck status from a request body: undefined/null = not given. */
function deckStatus(v) {
  if (v == null) return null;
  if (!DECK_STATUSES.includes(v)) throw new HttpError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  return v;
}

/** PATCH /api/decks/:id {name?, format?, description?, status?, bracket_declared?} -> the deck row. */
async function patchDeck(req, id) {
  const deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
  if (!deck) throw new HttpError(404, "Deck not found");
  const body = await readJson(req);
  const name = body.name === undefined ? deck.name : optString(body.name, "name", 200);
  if (!name) throw new HttpError(400, "name must not be empty");
  const format = body.format === undefined ? deck.format : normalizeFormat(optString(body.format, "format", 50));
  const description = body.description === undefined ? deck.description : optString(body.description, "description", 5000) || null;
  const status = deckStatus(body.status) ?? deck.status;
  const declared = bracketDeclared(body.bracket_declared);
  const bracket = declared === undefined ? deck.bracket_declared : declared;
  // Idea -> built: the cards this deck now shares with other built decks (they were "in use" while it was an idea).
  const before = status === "built" && deck.status !== "built" ? deckDetail(db, id) : null;
  db.prepare("UPDATE decks SET name = ?, format = ?, description = ?, status = ?, bracket_declared = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, format, description, status, bracket, id);
  // A format change can make it a commander deck (or not).
  if (format !== deck.format) scheduleSpellbook(id);
  const row = db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
  if (status === deck.status) return row;
  const after = deckDetail(db, id);
  return {
    ...row,
    status_change: {
      from: deck.status, to: status,
      in_use_count: before?.in_use_count ?? 0,
      in_use: before?.shopping.in_use ?? [],
      conflict_count: after.conflict_count,
    },
  };
}

/** GET /api/decks/:id/status-preview?status=built -> what switching would change (the UI's confirm text). */
function statusPreview(id, status) {
  const detail = deckDetail(db, id);
  if (!detail) throw new HttpError(404, "Deck not found");
  if (!DECK_STATUSES.includes(status)) throw new HttpError(400, `status must be ${DECK_STATUSES.join(" or ")}`);
  const toBuilt = status === "built" && detail.status !== "built";
  return {
    from: detail.status, to: status,
    in_use_count: toBuilt ? detail.in_use_count : 0,
    in_use: toBuilt ? detail.shopping.in_use : [],
  };
}

/** POST /api/decks/:id/to-binder {binder?, confirm_master?} -> moved/missing summary + deck detail. */
async function postDeckToBinder(req, id) {
  const body = await readJson(req);
  const binder = optString(body.binder, "binder", 200);
  const result = await exclusive(async () => scanCall(() => deckToBinder(db, id, { binder, confirm_master: body.confirm_master === true })));
  return { ...result, deck: getDeckOr404(id) };
}

const deckCall = (fn) => { try { return fn(); } catch (err) { throw err instanceof DeckError ? new HttpError(err.status, err.message) : err; } };

/** PATCH /api/decks/:id/cards {name, board, to_board?, quantity?} -> deck detail + change. */
async function patchDeckCard(req, id) {
  const body = await readJson(req);
  const change = deckCall(() => updateDeckCard(db, id, {
    name: optString(body.name, "name", 300), board: body.board, to_board: body.to_board ?? null, quantity: body.quantity ?? null,
  }));
  scheduleSpellbook(id);
  return { ...getDeckOr404(id), change };
}

/** POST /api/decks/:id/commander {name, replace?} -> deck detail + change. */
async function postCommander(req, id) {
  const body = await readJson(req);
  const change = deckCall(() => setCommander(db, id, { name: optString(body.name, "name", 300), replace: optString(body.replace, "replace", 300) }));
  scheduleSpellbook(id);
  return { ...getDeckOr404(id), change };
}

function exportFilename(name) {
  const ascii = name.replace(/[^\w .()-]+/g, "_").trim() || "deck";
  return `attachment; filename="${ascii}.txt"; filename*=UTF-8''${encodeURIComponent(name)}.txt`;
}

// ---------------------------------------------------------------------------
// Chats

/** chatId → AbortController of the running Claude turn. */
const runs = new Map();

function messageRow(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    tools: parseJsonField(m.tools, []),
    cost_usd: m.cost_usd,
    created_at: m.created_at,
  };
}

function getChatOr404(id) {
  const chat = db.prepare("SELECT id, title, session_id, created_at, updated_at FROM chats WHERE id = ?").get(id);
  if (!chat) throw new HttpError(404, "Chat not found");
  return chat;
}

function recapOf(chatId, beforeId) {
  const rows = db.prepare("SELECT role, content FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 6")
    .all(chatId, beforeId).reverse();
  return rows.map((m) => {
    const text = m.content.length > 800 ? m.content.slice(0, 800) + " […]" : m.content;
    return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
  }).join("\n\n");
}

async function postMessage(req, res, chatId) {
  const chat = getChatOr404(chatId);
  const body = await readJson(req);
  const text = optString(body.text, "text", MAX_MESSAGE_CHARS);
  if (!text) throw new HttpError(400, "text is required");
  if (!claudeConfigured()) throw new HttpError(503, "Claude is not configured: set CLAUDE_CODE_OAUTH_TOKEN");
  if (runs.has(chatId)) throw new HttpError(409, "This chat is already answering; wait for it to finish");
  if (runs.size + activeClaudeRuns().vision >= MAX_CONCURRENT) throw new HttpError(429, `Too many Claude runs in progress (max ${MAX_CONCURRENT}); try again shortly`);

  const controller = new AbortController();
  runs.set(chatId, controller);
  const turnStart = sqlNow(); // decks Claude saves in this turn get their combos checked afterwards

  let userMsgId;
  try {
    const isFirst = !db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND role = 'user' LIMIT 1").get(chatId);
    userMsgId = Number(db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chatId, text).lastInsertRowid);
    const title = isFirst ? text.replace(/\s+/g, " ").slice(0, 60) : chat.title;
    db.prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, chatId);
  } catch (err) {
    runs.delete(chatId);
    throw err;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  let open = true;
  res.on("close", () => { open = false; });
  const send = (ev) => {
    if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // Comment line every 15 s keeps proxies from closing a quiet stream.
  const keepAlive = setInterval(() => { if (open) res.write(": ping\n\n"); }, 15000);
  send({ type: "start" });

  // The run is not tied to the HTTP response: it finishes and is stored even
  // if the browser goes away.
  let result;
  try {
    result = await runTurn({
      prompt: text,
      sessionId: chat.session_id,
      recap: chat.session_id ? recapOf(chatId, userMsgId) : "",
      onEvent: send,
      signal: controller.signal,
    });
  } catch (err) {
    result = { text: "", tools: [], costUsd: null, sessionId: null, isError: true, error: err.message };
  } finally {
    runs.delete(chatId);
    clearInterval(keepAlive);
    scheduleEnglishPrices();
    scheduleChangedDecks(turnStart);
  }

  try {
    if (!db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)) {
      send({ type: "error", error: "Chat was deleted" });
    } else {
      let content = result.text || "";
      if (result.isError) content = `${content}${content ? "\n\n" : ""}**Error:** ${result.error}`;
      const info = db.prepare("INSERT INTO messages (chat_id, role, content, tools, cost_usd) VALUES (?, 'assistant', ?, ?, ?)")
        .run(chatId, content, JSON.stringify(result.tools || []), result.costUsd ?? null);
      db.prepare("UPDATE chats SET session_id = COALESCE(?, session_id), updated_at = datetime('now') WHERE id = ?")
        // A turn that failed before producing anything (auth error, ...) leaves
        // no useful session behind; keep resuming the previous one instead. One
        // that ran tools (timeout, cancel) did real work worth resuming.
        .run(result.isError && !result.text && !(result.tools || []).length ? null : result.sessionId || null, chatId);
      const stored = messageRow(db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(info.lastInsertRowid)));
      if (result.isError) send({ type: "error", error: result.error });
      else send({ type: "done", message: stored });
    }
  } catch (err) {
    console.error("[chat] storing the answer failed:", err);
    send({ type: "error", error: `Could not store the answer: ${err.message}` });
  }
  if (open) res.end();
}

// ---------------------------------------------------------------------------
// Scanner: card index jobs, identification, staging list, binders

/** ScanError (lib/scans.js) -> HttpError; everything else passes through. */
function scanErr(err) {
  if (err instanceof ScanError) return new HttpError(err.status, err.message);
  if (err instanceof BinderError) return new HttpError(err.status, err.message, err.extra);
  return err;
}
const scanCall = (fn) => { try { return fn(); } catch (err) { throw scanErr(err); } };

/** Card index lookup for lib/edits.js (printing facts: oracle, language, finishes), or null without an index. */
const editPrintingLookup = () => (idx ? (id) => indexLookup("getPrinting", id) : null);

function requireIndex() {
  if (!idx) throw new HttpError(503, "The card index is not available");
  return idx;
}

let indexReadyCache = false;
function indexReady() {
  if (!idx) return false;
  if (indexReadyCache) return true;
  try { indexReadyCache = Boolean(idx.prepare("SELECT 1 FROM printings LIMIT 1").get()); } catch { indexReadyCache = false; }
  return indexReadyCache;
}

/**
 * The matcher for a scan. The worker waits for its own warm-up inside
 * hashImage (bounded) and skips hashing without fingerprints; the in-process
 * matcher only once it has fingerprints (else hashing a scan is wasted work).
 */
function readyMatcher() {
  if (!matcher) return null;
  if (matcher instanceof MatcherWorker) return matcher.state === "closed" ? null : matcher;
  try {
    matcher.ensureLoaded();
    return matcher.size > 0 ? matcher : null;
  } catch (err) {
    console.warn(`[scanner] fingerprints unavailable: ${err.message}`);
    return null;
  }
}

/**
 * A card-index lookup on the matcher worker's connection: a scan makes dozens
 * of them (title search ~70 ms warm, >1 s on a cold cache; collector lookups
 * blocked >1 s in a row cold). Errors of a call (also a timeout) are thrown,
 * never retried on the main thread; while the worker respawns after a crash
 * a lookup waits for it (bounded). In-process only for an in-memory index or
 * a worker that is closed or gave up.
 */
async function indexLookup(fn, ...args) {
  if (matcher instanceof MatcherWorker && matcher.available) {
    if (!(await matcher.whenRunning(INDEX_LOOKUP_WAIT_MS))) throw new HttpError(503, "The card index is restarting; try again shortly");
    return matcher.indexCall(fn, args);
  }
  return indexModule[fn](idx, ...args);
}
const INDEX_LOOKUP_WAIT_MS = 15000;
const titleSearch = (text, opts) => indexLookup("searchTitle", text, opts);
// Set codes for the OCR's set matcher (sync API): cached until an index job
// ends, loaded through the worker before a scan needs them.
let setCodesCache = null;
async function loadSetCodes() {
  if (!setCodesCache) setCodesCache = await indexLookup("setCodes");
  return setCodesCache;
}
// identify()'s index functions: the lookups run off the event loop.
const scanIndex = { ...indexModule, setCodes: (i) => (setCodesCache ??= indexModule.setCodes(i)) };
for (const fn of ["lookupCollector", "lookupLegacyNumber", "getPrinting", "printingsOf", "variantsOf", "storagePrinting", "searchTitle"]) {
  scanIndex[fn] = (_idx, ...args) => indexLookup(fn, ...args);
}

// Background index jobs, one at a time (the work itself runs in a worker thread).
const JOB_DONE = Symbol("job done");
const indexJob = { running: null, last: null, controller: null };

function startIndexJob(kind, { then = null } = {}) {
  requireIndex();
  if (indexJob.running) throw new HttpError(409, `The ${indexJob.running.kind} job is already running`);
  const controller = new AbortController();
  const state = { kind, state: "running", running: true, started_at: new Date().toISOString(), progress: null };
  indexJob.running = state;
  indexJob.controller = controller;
  // Progress objects (done/total/phase/...) are flattened for the UI.
  const onProgress = (p) => {
    state.progress = p;
    if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (!["kind", "state", "running"].includes(k)) state[k] = v;
  };
  // Both jobs run in a worker thread (the refresh's finalize step and the
  // fingerprint job's whole-table statements are seconds of synchronous
  // SQLite work); an in-memory index can only run them in-process.
  const source = process.env.INDEX_BULK_SOURCE || undefined;
  const inProcess = INDEX_FILE === ":memory:";
  const work = kind === "refresh"
    ? (inProcess
      ? refreshIndex(idx, { signal: controller.signal, onProgress, source })
      : refreshIndexInWorker(INDEX_FILE, { signal: controller.signal, onProgress, source }))
    : (inProcess
      ? buildFingerprints(idx, { signal: controller.signal, onProgress })
      : buildFingerprintsInWorker(INDEX_FILE, { signal: controller.signal, onProgress }));
  console.log(`[scanner] ${kind} job started`);
  const finished = work.then(
    (result) => {
      indexJob.last = { kind, ok: true, state: "done", finished_at: new Date().toISOString(), result: result ?? null };
      console.log(`[scanner] ${kind} job finished`);
      return indexJob.last;
    },
    (err) => {
      indexJob.last = { kind, ok: false, state: "error", finished_at: new Date().toISOString(), error: err.message };
      console.warn(`[scanner] ${kind} job failed: ${err.message}`);
      return indexJob.last;
    },
  ).finally(() => {
    indexJob.running = null;
    indexJob.controller = null;
    indexReadyCache = false;
    setCodesCache = null;
    scheduleEnglishPrices();
  });
  // [JOB_DONE] settles when this job and its follow-up (`then`) are finished; it
  // rejects when either fails. Not enumerable: state is sent to the UI as JSON.
  const done = finished.then((last) => {
    if (!last.ok) throw new Error(`${kind}: ${last.error}`);
    if (kind === "refresh" && then && !shuttingDown) {
      let next;
      try { next = startIndexJob(then); } catch (err) { console.warn(`[scanner] could not start ${then}: ${err.message}`); throw err; }
      return next[JOB_DONE];
    }
    return last;
  });
  done.catch(() => { /* reported via indexJob.last */ });
  // A symbol: progress is flattened into `state`, and the fingerprint job's
  // progress has its own `done` count (a "done" key would be overwritten,
  // or, read-only, throw on the first progress message from the worker).
  Object.defineProperty(state, JOB_DONE, { value: done, enumerable: false });
  return state;
}

function autoIndex() {
  if (!idx || process.env.SCAN_AUTO_INDEX === "false") return;
  try {
    const st = indexBrief(idx);
    if (!st.printings) startIndexJob("refresh", { then: "fingerprints" });
    // Not finished (interrupted by a restart or redeploy, which leaves it
    // 'paused' or 'running', stopped by errors, or never started): resume.
    // Already-hashed groups are skipped, so this is cheap when little is left.
    else if (st.fingerprint_job?.state !== "done") startIndexJob("fingerprints");
  } catch (err) {
    console.warn(`[scanner] automatic index build not started: ${err.message}`);
  }
}

function decodeImage(v, field, { required = true, maxPixels } = {}) {
  if (v == null || v === "") {
    if (required) throw new HttpError(400, `${field} is required (base64 JPEG)`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a base64 string`);
  const buf = Buffer.from(v.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(400, `${field} is not a JPEG image`);
  try {
    checkJpegSize(buf, maxPixels);
  } catch (err) {
    throw new HttpError(400, `${field}: ${err.message}`);
  }
  return buf;
}

function scanSettings(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "settings must be an object");
  const storageLang = raw.storageLang ?? indexModule.STORE_AS_SCANNED;
  if (!STORAGE_LANGS.includes(storageLang)) throw new HttpError(400, `settings.storageLang must be one of ${STORAGE_LANGS.join(", ")}`);
  const foil = raw.foil ?? "auto";
  if (!["auto", "foil", "nonfoil"].includes(foil)) throw new HttpError(400, "settings.foil must be auto, foil or nonfoil");
  const setHint = raw.setHint ? String(raw.setHint).trim().toLowerCase() : null;
  if (setHint && !/^[a-z0-9]{2,8}$/.test(setHint)) throw new HttpError(400, "settings.setHint must be a set code");
  const condition = raw.condition ?? "near_mint";
  if (!CONDITIONS.includes(condition)) throw new HttpError(400, `settings.condition must be one of ${CONDITIONS.join(", ")}`);
  // precise: the client tracked a stable quad (not a fallback crop); the scanner then hashes 9 query variants, not 27.
  if (raw.precise != null && typeof raw.precise !== "boolean") throw new HttpError(400, "settings.precise must be a boolean");
  return { storageLang, foil, setHint, condition, precise: raw.precise === true };
}

/** ?source=a,b of the calibration export: label sources to include (null = all; unknown names 400). */
function calibrationSources(query) {
  const raw = query.get("source");
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !LABEL_SOURCES.includes(s));
  if (bad.length) throw new HttpError(400, `source must be one of ${LABEL_SOURCES.join(", ")}`);
  return list;
}

/** Optional capture-controller fields of a scan request: {capture, dupOf}. */
function captureFields(body) {
  const capture = body.capture ?? null;
  if (capture !== null && (typeof capture !== "object" || Array.isArray(capture))) throw new HttpError(400, "capture must be an object");
  const dupOf = body.dup_of == null ? null : Number(body.dup_of);
  if (dupOf != null && !(Number.isInteger(dupOf) && dupOf > 0)) throw new HttpError(400, "dup_of must be a scan id");
  return { capture, dupOf };
}

/** identify() result without the bulky calibration features. */
function resultSummary(r) {
  return {
    status: r.status,
    method: r.method,
    confidence: r.confidence,
    finish: r.finish,
    finishSource: r.finishSource,
    lang_detected: r.lang_detected,
    printing: printingSummary(r.printing),
    store: printingSummary(r.store),
    candidates: r.candidates,
    variants: r.variants,
    claude_used: r.claude_used,
    claude: r.features?.claude ? { skipped: r.features.claude.skipped ?? null, resets_at: r.features.claude.resets_at ?? null, verdict: r.features.claude.verdict ?? null } : null,
    reasons: r.features?.local?.reasons ?? [],
    errors: r.features?.errors ?? [],
    timings: r.timings,
  };
}

// Identify slots shared by normal scans and recognition probes.
const scanSlots = createScanSlots(SCAN_MAX_CONCURRENT);
// Probes answer 'busy' while the fingerprint matcher is still loading: a
// probe must never sit on a slot for the SCAN_MATCHER_WAIT_MS warm-up.
const prober = new ProbeRunner({
  slots: scanSlots,
  warming: () => matcher instanceof MatcherWorker && matcher.state === "loading",
});

/** body.probe_session: optional client-generated id ([A-Za-z0-9-]{1,40}). */
function probeSession(body) {
  const v = body.probe_session;
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !PROBE_SESSION_RE.test(v)) throw new HttpError(400, "probe_session must be 1-40 letters, digits or dashes");
  return v;
}

async function postScan(req, res) {
  // A client that gives up (UI timeout/cancel, closed tab) cancels the scan:
  // no Claude call is started or kept running, and nothing is staged, so a
  // Retry can never stage the same card twice.
  const gone = new AbortController();
  res.on("close", () => { if (!res.writableFinished) gone.abort(new Error("client closed the request")); });
  const body = await readJson(req, SCAN_LIMIT);
  if (body.mode != null && !["scan", "probe"].includes(body.mode)) throw new HttpError(400, "mode must be scan or probe");
  const session = probeSession(body);
  const { capture, dupOf } = captureFields(body);
  if (body.mode === "probe") return postProbe(body, { gone, session, capture });
  requireIndex();
  if (!indexReady()) throw new HttpError(503, "The card index is still being built; try again when it is ready");
  const card = decodeImage(body.card, "card", { maxPixels: MAX_CARD_PIXELS });
  const strip = decodeImage(body.strip, "strip", { required: false, maxPixels: MAX_STRIP_PIXELS });
  const replaceId = body.replace_id == null ? null : Number(body.replace_id);
  if (replaceId != null && !(Number.isInteger(replaceId) && replaceId > 0)) throw new HttpError(400, "replace_id must be a scan id");
  const settings = scanSettings(body.settings ?? {});
  if (!scanSlots.tryAcquire()) throw new HttpError(429, "Still identifying the previous scans; try again shortly");
  let result;
  try {
    await loadSetCodes().catch(() => null);
    // Upside-down cards are retried turned by 180° (the stored photo is then upright).
    result = await identifyOriented(
      { db, idx, index: scanIndex, matcher: readyMatcher(), signal: gone.signal, claude: { runVision: claudeConfigured() ? runVision : null, cap: visionCap } },
      { card, strip, settings: { ...settings, allowClaude: body.allowClaude !== false } },
    );
  } finally {
    scanSlots.release();
  }
  if (gone.signal.aborted) throw new HttpError(499, "Scan cancelled: the client closed the request");
  const staged = stageScan(db, result, {
    image: result.upright?.card ?? card, strip: result.upright?.strip ?? strip, force: body.force === true, condition: settings.condition, calibration: body.calibration === true, replaceId,
    dupOf, capture, session,
  });
  // A shutter scan inside a probe session: the next probe compares against it.
  prober.noteScan(session, result, staged.scan);
  // EUR price of the stored printing + finish: the UI picks the scan sound by it.
  const price = await scanPriceEur(result, {
    db, lookupEn: (p) => indexLookup("storagePrinting", p, "en").catch(() => null),
  });
  // implicitly_confirmed: the session's SUGGEST rows this new card settled (lib/scans.js confirmImplicitly).
  return { scan: staged.scan, duplicate: staged.duplicate, implicitly_confirmed: staged.confirmed ?? [], result: { ...resultSummary(result), ...price } };
}

/**
 * Recognition probe (body.mode 'probe'): local identification only (never
 * Claude), staged only when identified and not the session's last card; see
 * ProbeRunner in lib/scans.js. Always 200: {probe, outcome, reason?, scan?,
 * finish_upgraded?, result}. 'busy' answers at once (no queueing behind slow scans).
 */
async function postProbe(body, { gone, session, capture }) {
  requireIndex();
  if (!indexReady()) throw new HttpError(503, "The card index is still being built; try again when it is ready");
  const card = decodeImage(body.card, "card", { maxPixels: MAX_CARD_PIXELS });
  const strip = decodeImage(body.strip, "strip", { required: false, maxPixels: MAX_STRIP_PIXELS });
  const settings = scanSettings(body.settings ?? {});
  // No Claude: no runVision and allowClaude false.
  const identify = async () => {
    await loadSetCodes().catch(() => null);
    return identifyOriented(
      { db, idx, index: scanIndex, matcher: readyMatcher(), signal: gone.signal, claude: { runVision: null, cap: visionCap } },
      { card, strip, settings: { ...settings, allowClaude: false } },
    );
  };
  const out = await prober.run(db, identify, { session, image: card, strip, condition: settings.condition, calibration: body.calibration === true, capture, signal: gone.signal });
  if (out.outcome === "cancelled") throw new HttpError(499, "Probe cancelled: the client closed the request");
  const response = {
    probe: true, outcome: out.outcome, ...(out.reason ? { reason: out.reason } : {}), ...(out.scan ? { scan: out.scan } : {}),
    ...(out.finish_upgraded ? { finish_upgraded: true } : {}),
    ...(out.confirmed?.length ? { implicitly_confirmed: out.confirmed } : {}),
  };
  const r = out.result;
  if (!r) return { ...response, result: null };
  const status = r.printing ? r.status ?? "failed" : "failed";
  // Unidentified: only the status (a REVIEW guess is not something to show).
  if (out.outcome === "unidentified") return { ...response, result: { status, timings: r.timings ?? null } };
  const p = r.store || r.printing;
  const price = await scanPriceEur(r, { db, lookupEn: (x) => indexLookup("storagePrinting", x, "en").catch(() => null) });
  return {
    ...response,
    result: {
      status, name: p.name ?? null, printing_id: r.printing.id, store_printing_id: p.id, finish: probeKey(r)?.finish ?? null,
      confidence: r.confidence ?? null, price_eur: price.price_eur ?? null, timings: r.timings ?? null,
    },
  };
}

async function postManualScan(req) {
  const body = await readJson(req);
  requireIndex();
  const printingId = optString(body.printing_id, "printing_id", 64);
  if (!printingId) throw new HttpError(400, "printing_id is required");
  const printing = await indexLookup("getPrinting", printingId);
  if (!printing) throw new HttpError(404, "Printing not found");
  const wanted = normFinish(body.finish);
  const settings = scanSettings({ storageLang: body.storageLang, condition: body.condition, foil: wanted === "foil" ? "foil" : "auto" });
  const store = (await indexLookup("storagePrinting", printing, settings.storageLang)) || printing;
  let finish = decideFinish(store, { foilMode: settings.foil }).finish;
  if (wanted != null) {
    if (!["normal", "foil", "etched"].includes(wanted)) throw new HttpError(400, "finish must be normal, foil or etched");
    finish = wanted;
  }
  const quantity = body.quantity == null ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, "quantity must be 1-999");
  let variants = [];
  try { variants = (await indexLookup("variantsOf", printing)).map((p) => printingSummary(p)); } catch { variants = []; }
  const result = {
    status: "manual", printing, store, finish, finishSource: "user", method: "manual", confidence: 1,
    candidates: [], variants, quantity, features: { manual: true, settings: { storageLang: settings.storageLang } },
  };
  const staged = scanCall(() => stageScan(db, result, { force: true, condition: settings.condition }));
  // Keep the chosen finish even when it is not listed (the row is the user's call).
  if (staged.scan && staged.scan.finish !== finish) db.prepare("UPDATE scans SET finish = ? WHERE id = ?").run(finish, staged.scan.id);
  return getScan(db, staged.scan.id);
}

function sendScanImage(res, id, kind = "image") {
  const file = kind === "strip" ? scanStripPath(db, id) : scanImagePath(db, id);
  if (!file) throw new HttpError(404, `No ${kind} stored for this scan`);
  return stat(file).then((info) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": info.size, "Cache-Control": "private, max-age=3600" });
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }, () => { throw new HttpError(404, `No ${kind} stored for this scan`); });
}

async function handleScanApi(req, res, url) {
  const { pathname, searchParams: query } = url;
  const method = req.method;
  let m;

  if (pathname === "/api/scan" && method === "POST") return sendJson(res, 200, await postScan(req, res));
  if (pathname === "/api/scans" && method === "GET") {
    const status = query.get("status") || "staged";
    if (!["staged", "committed", "all"].includes(status)) throw new HttpError(400, "status must be staged, committed or all");
    // Rows carry price_eur; the staged list also its totals (the scanner's running value).
    const scans = listScans(db, { status });
    const totals = await priceScans(db, scans, { indexPrices: idx ? (items) => indexLookup("printingPricesEur", items) : null });
    return sendJson(res, 200, status === "staged" ? { scans, totals: { staged: totals } } : { scans });
  }
  if (pathname === "/api/scans/undo" && method === "POST") return sendJson(res, 200, undoLast(db));
  if (pathname === "/api/scans/capture-log" && method === "GET") return sendJson(res, 200, captureLog(db));
  if (pathname === "/api/scans/learning" && method === "GET") return sendJson(res, 200, learningReport(db));
  if (pathname === "/api/scans/manual" && method === "POST") return sendJson(res, 201, await postManualScan(req));
  if (pathname === "/api/scans/commit" && method === "POST") {
    const body = await readJson(req);
    const since = sqlNow();
    const result = await exclusive(() => commitScans(db, body.ids, body.target, { idx }).catch((err) => {
      throw err instanceof ScanError ? scanErr(err) : importError(err);
    }));
    if (body.target?.type === "deck") scheduleChangedDecks(since);
    return sendJson(res, 200, result);
  }
  if ((m = /^\/api\/scans\/(\d+)(?:\/(image|strip|increment|truth))?$/.exec(pathname))) {
    const id = Number(m[1]);
    if (m[2] === "image" || m[2] === "strip") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return sendScanImage(res, id, m[2]);
    }
    if (m[2] === "increment") {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readJson(req, INCREMENT_LIMIT);
      const { capture } = captureFields({ capture: body.capture });
      return sendJson(res, 200, scanCall(() => incrementScan(db, id, { capture })));
    }
    if (m[2] === "truth") {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readJson(req);
      return sendJson(res, 200, scanCall(() => recordTruth(db, id, { printing_id: body.printing_id, finish: body.finish }, { idx })));
    }
    if (method === "GET") {
      const scan = getScan(db, id, { features: query.get("features") === "1" });
      if (!scan) throw new HttpError(404, "Scan not found");
      return sendJson(res, 200, scan);
    }
    if (method === "PATCH") {
      const body = await readJson(req);
      const patch = {};
      for (const k of ["printing_id", "finish", "quantity", "condition", "store_lang", "confirm"]) if (body[k] !== undefined) patch[k] = body[k];
      return sendJson(res, 200, scanCall(() => updateScan(db, id, patch, { idx })));
    }
    if (method === "DELETE") {
      scanCall(() => deleteScan(db, id, { createdAt: query.get("created_at") || null }));
      return sendEmpty(res);
    }
    throw new HttpError(405, "Method not allowed");
  }

  if (pathname === "/api/printings" && method === "GET") {
    requireIndex();
    const oracleId = query.get("oracle_id");
    if (!oracleId) throw new HttpError(400, "oracle_id is required");
    const lang = query.get("lang") || undefined;
    return sendJson(res, 200, (await indexLookup("printingsOf", oracleId, { lang })).slice(0, 400).map((p) => printingSummary(p)));
  }
  if (pathname === "/api/printings/search" && method === "GET") {
    requireIndex();
    const q = (query.get("q") || "").trim().slice(0, 200);
    if (q.length < 2) return sendJson(res, 200, []);
    const lang = query.get("lang") || undefined;
    const hits = await titleSearch(q, { lang, limit: 12 });
    const printings = await Promise.all(hits.map((h) => indexLookup("getPrinting", h.id)));
    return sendJson(res, 200, hits.map((h, i) => ({ ...h, printing: printingSummary(printings[i]) })));
  }

  if (pathname === "/api/binders" && method === "GET") return sendJson(res, 200, listBinders(db));
  if (pathname === "/api/binders" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 201, await exclusive(async () => scanCall(() => createBinder(db, body.name))));
  }
  if ((m = /^\/api\/binders\/(.+)$/.exec(pathname))) {
    let name;
    try { name = decodeURIComponent(m[1]); } catch { throw new HttpError(400, "Bad binder name"); }
    if (method === "PATCH") {
      const body = await readJson(req);
      return sendJson(res, 200, await exclusive(async () => scanCall(() => renameBinder(db, name, body.name, { confirm_master: body.confirm_master === true }))));
    }
    if (method === "DELETE") {
      // ?cards=unsort|delete. The legacy ?source=scan (unlogged delete of the scanned rows) answers 400.
      const opts = query.has("source")
        ? { source: query.get("source") }
        : { cards: query.get("cards") || "unsort", confirm_master: query.get("confirm_master") === "1" };
      return sendJson(res, 200, await exclusive(async () => scanCall(() => deleteBinder(db, name, opts))));
    }
    throw new HttpError(405, "Method not allowed");
  }

  if (pathname === "/api/index/status" && method === "GET") {
    requireIndex();
    return sendJson(res, 200, {
      ...(await indexLookup("indexStatus")),
      job: indexJob.running,
      last_job: indexJob.last,
      refresh_job: indexJob.running?.kind === "refresh" ? indexJob.running : indexJob.last?.kind === "refresh" ? indexJob.last : null,
      claude: { configured: claudeConfigured(), per_hour: visionCap.limit, remaining: visionCap.remaining() },
      scheduler: scheduler.status(),
    });
  }
  if (pathname === "/api/index/refresh" && method === "POST") return sendJson(res, 202, { started: startIndexJob("refresh") });
  if (pathname === "/api/index/fingerprints" && method === "POST") return sendJson(res, 202, { started: startIndexJob("fingerprints") });

  if (pathname === "/api/calibration/export" && method === "GET") {
    const data = JSON.stringify({ exported_at: new Date().toISOString(), version: VERSION, scans: exportCalibration(db, { sources: calibrationSources(query) }) }, null, 1);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="scanner-calibration.json"',
      "Cache-Control": "no-store",
    });
    return res.end(data);
  }
  return null;
}

/**
 * Claude CLI presence for /healthz: lib/claude.js's claudeCliStatus() when it
 * provides one, else whether CLAUDE_BIN (set by the image's entrypoint) exists.
 */
function claudeCliHealth() {
  try {
    if (typeof claudeLib.claudeCliStatus === "function") return claudeLib.claudeCliStatus();
  } catch (err) {
    return { status: "missing", version: null, error: err.message };
  }
  const bin = process.env.CLAUDE_BIN;
  if (!bin) return { status: "unknown", version: null };
  return { status: existsSync(bin) ? "installed" : "missing", version: process.env.CLAUDE_CODE_VERSION || null };
}

// Index counts for /healthz, stale-while-revalidate: the COUNT(*)s run on the
// matcher worker (cold cache: >100 ms, and they queue behind a scan's
// matching there), so a request never waits for them beyond the first
// 100 ms after a start; later requests get the previous counts while one
// refresh runs in the background.
let healthCache = null;
let healthRefresh = null;
function refreshScannerHealth() {
  healthRefresh ??= (async () => {
    const tools = await ocrTools().catch(() => ({ tesseract: false, djpeg: false }));
    let st = null;
    try {
      st = idx ? await indexLookup("indexStatus") : null;
    } catch {
      // Worker restarting: keep the last counts rather than count on the main thread.
      if (healthCache) return (healthCache = { at: Date.now(), value: { ...healthCache.value, tesseract: tools.tesseract, djpeg: tools.djpeg } }).value;
    }
    const value = { index_ready: Boolean(st?.printings), fingerprints: st?.fingerprints ?? 0, tesseract: tools.tesseract, djpeg: tools.djpeg };
    healthCache = { at: Date.now(), value };
    return value;
  })().finally(() => { healthRefresh = null; });
  return healthRefresh;
}
async function scannerHealth() {
  if (!healthCache || Date.now() - healthCache.at >= 30000) {
    const pending = refreshScannerHealth();
    if (!healthCache) {
      let timer;
      const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 100); });
      await Promise.race([pending, slow]).finally(() => clearTimeout(timer));
    }
  }
  const value = healthCache?.value ?? { index_ready: indexReadyCache || null, fingerprints: null, tesseract: null, djpeg: null, pending: true };
  return {
    ...value, ocr_helper: ocrHelperStatus(), matcher: matcherHealth(), probes: prober.stats(),
    // the UI's auto-ask for hard cards is off when the cap is 0 or Claude is not configured
    vision: { configured: claudeConfigured(), per_hour: visionCap.limit, remaining: visionCap.remaining(), resets_at: visionCap.resetsAt() },
  };
}

/** scanner.matcher for /healthz: loading | ready | error (+ size, load time), never cached. */
function matcherHealth() {
  if (!matcher) return { state: "unavailable" };
  if (matcher instanceof MatcherWorker) return matcher.status();
  return { state: "in-process", size: matcher.size, load_ms: matcher.loadMs ?? null };
}

// ---------------------------------------------------------------------------
// Record session (Scan settings switch): small frames + capture decision
// records for offline replay (lib/debugsessions.js). Not part of backups.

const debugSessions = new DebugSessions();
// Scanner perf beacons (every ~5 s while the camera runs), last 500 kept. Not part of backups.
const debugPerf = new DebugPerf();

async function handleDebugApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const call = async (fn) => { try { return await fn(); } catch (err) { throw err instanceof DebugError ? new HttpError(err.status, err.message) : err; } };
  if (pathname === "/api/debug/frames" && method === "POST") {
    const body = await readJson(req, DEBUG_FRAME_LIMIT);
    let frame = null;
    if (body.jpeg != null && body.jpeg !== "") {
      if (typeof body.jpeg !== "string") throw new HttpError(400, "jpeg must be a base64 string");
      frame = Buffer.from(body.jpeg.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    }
    await call(() => debugSessions.add({ session: body.session, seq: body.seq, frame, record: body.record ?? undefined }));
    return sendEmpty(res);
  }
  if (pathname === "/api/debug/perf") {
    const perf = async (fn) => { try { return await fn(); } catch (err) { throw err instanceof PerfError ? new HttpError(err.status, err.message) : err; } };
    if (method === "POST") {
      const body = await readJson(req, DEBUG_PERF_LIMIT);
      await perf(() => debugPerf.add(body));
      return sendEmpty(res);
    }
    if (method === "GET") return sendJson(res, 200, { entries: await perf(() => debugPerf.list({ limit: url.searchParams.get("limit") ?? 100 })) });
  }
  if (pathname === "/api/debug/sessions" && method === "GET") return sendJson(res, 200, { sessions: await call(() => debugSessions.list()) });
  const m = /^\/api\/debug\/sessions\/([^/]+)$/.exec(pathname);
  if (m && method === "DELETE") {
    let id;
    try { id = decodeURIComponent(m[1]); } catch { throw new HttpError(400, "Invalid session id"); }
    if (!(await call(() => debugSessions.delete(id)))) throw new HttpError(404, "Session not found");
    return sendEmpty(res);
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Backups (lib/backups.js): manual snapshots of the app DB and restoring one.
// UI only: the collection MCP server has no backup tools.

let backupBusy = false; // one backup or restore at a time
let restoring = false; // while true every other state-changing request gets 503

const backupCall = async (fn) => {
  try { return await fn(); } catch (err) { throw err instanceof BackupError ? new HttpError(err.status, err.message) : err; }
};

function backupName(raw) {
  let name;
  try { name = decodeURIComponent(raw); } catch { throw new HttpError(400, "Invalid backup name"); }
  return name;
}

async function postBackup() {
  if (backupBusy) throw new HttpError(409, "A backup or restore is already running");
  backupBusy = true;
  try {
    return await backupCall(() => createBackup(db, { dir: BACKUP.dir, kind: "manual", version: VERSION, keep: BACKUP.keep }));
  } finally { backupBusy = false; }
}

/** Why a restore can't run now (work that holds or writes the app DB), or null. */
function restoreBlocker() {
  if (backupBusy) return "a backup or restore is already running";
  if (importBusy) return "an import, price refresh or collection change is running";
  if (runs.size) return "the planner is answering a chat (its MCP server has the database open)";
  if (scanSlots.used) return "a scan is being identified";
  return null;
}

/**
 * Restore from a stored backup (`name`) or an uploaded .db.gz (`upload`
 * Buffer): unpack + validate, take a pre-restore safety backup, swap the file,
 * reopen (migrations upgrade older backups). The live DB stays untouched until
 * the swap, and a failed swap rolls back to it.
 */
async function restoreBackup({ name = null, upload = null }) {
  const blocker = restoreBlocker();
  if (blocker) throw new HttpError(409, `Can't restore right now: ${blocker}. Try again when it has finished.`);
  backupBusy = true;
  restoring = true;
  importBusy = true; // imports, moves and the scheduler's price refresh wait for us
  const tmp = `${DB_FILE}.restore-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    return await backupCall(async () => {
      const source = name ? backupPath(BACKUP.dir, name) : upload;
      const stored = name ? listBackups(BACKUP.dir).find((b) => b.name === name) ?? null : null;
      await gunzipToFile(source, tmp);
      const checked = validateBackupDb(tmp, { schemaVersion: SCHEMA_VERSION, imageDir: defaultImageDir() });
      const safety = await createBackup(db, { dir: BACKUP.dir, kind: "pre-restore", version: VERSION, protect: name ? [name] : [] });
      const spellbookOff = spellbookOptedOut(db); // the user's opt-out survives the restore
      try {
        db = swapDatabase({ dbFile: DB_FILE, newFile: tmp, close: () => db.close(), open: () => openDb(DB_FILE) });
      } catch (err) {
        if (err.db) db = err.db;
        console.error(`[backup] restore failed, previous database ${err.db ? "restored" : "COULD NOT BE REOPENED"}:`, err);
        if (!err.db) throw new HttpError(500, `Restore failed and the previous database could not be reopened: ${err.message}. Restart the app; safety backup: ${safety.name}`);
        throw new HttpError(500, `Restore failed, nothing was changed: ${err.message}`);
      }
      const restored = {
        name: name ?? null,
        source: name ? "stored" : "upload",
        restored_at: new Date().toISOString(),
        backup: stored,
        schema_version_before_upgrade: checked.schema_version,
        schema_version: db.prepare("PRAGMA user_version").get().user_version,
        counts: dbCounts(db),
      };
      try { setAppMeta(db, "last_restore", JSON.stringify({ at: new Date().toISOString(), from: name ?? "upload", safety_backup: safety.name })); } catch { /* informational */ }
      // The restored DB brings its own Spellbook settings, but an opt-out (in the live DB
      // before the restore, or SPELLBOOK_ENABLED=false) always wins: the stricter one is kept.
      try {
        seedSpellbookSettings(db, process.env, console, { keepOff: spellbookOff });
        pruneSpellbookCache(db);
      } catch (err) { console.warn(`[spellbook] ${err.message}`); }
      console.log(`[backup] restored ${name ?? "an uploaded backup"} (schema v${checked.schema_version} → v${restored.schema_version}); safety backup ${safety.name}`);
      return { restored, safety_backup: safety };
    });
  } finally {
    rmSync(tmp, { force: true });
    importBusy = false;
    restoring = false;
    backupBusy = false;
    scheduleEnglishPrices();
    scheduleCardFacts(); // a restored v8 backup lacks the v9 card facts
  }
}

const restoreConfirmed = (req, query, body = null) =>
  body?.confirm === true || query.get("confirm") === "1" || req.headers["x-confirm-restore"] === "1";

async function handleBackupApi(req, res, url) {
  const { pathname, searchParams: query } = url;
  const method = req.method;
  let m;
  if (pathname === "/api/backups") {
    if (method === "GET") return sendJson(res, 200, { backups: listBackups(BACKUP.dir), keep: BACKUP.keep });
    if (method === "POST") return sendJson(res, 201, await postBackup());
    throw new HttpError(405, "Method not allowed");
  }
  if (pathname === "/api/backups/restore-upload") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!["application/gzip", "application/x-gzip", "application/octet-stream"].includes(type)) {
      throw new HttpError(415, "Content-Type must be application/gzip or application/octet-stream");
    }
    if (!restoreConfirmed(req, query)) throw new HttpError(400, "A restore replaces all app data; confirm with confirm=1");
    const buf = await readBody(req, BACKUP_UPLOAD_LIMIT);
    if (!buf.length) throw new HttpError(400, "The uploaded file is empty");
    return sendJson(res, 200, await restoreBackup({ upload: buf }));
  }
  if ((m = /^\/api\/backups\/([^/]+)(?:\/(download|restore))?$/.exec(pathname))) {
    const name = backupName(m[1]);
    if (m[2] === "download") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const file = await backupCall(async () => backupPath(BACKUP.dir, name));
      const info = await stat(file);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": info.size,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      });
      const stream = createReadStream(file);
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }
    if (m[2] === "restore") {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readJson(req);
      await backupCall(async () => backupPath(BACKUP.dir, name));
      if (!restoreConfirmed(req, query, body)) throw new HttpError(400, "A restore replaces all app data; confirm with {confirm: true}");
      return sendJson(res, 200, await restoreBackup({ name }));
    }
    if (method === "DELETE") {
      if (backupBusy) throw new HttpError(409, "A backup or restore is running");
      await backupCall(async () => deleteBackup(BACKUP.dir, name));
      return sendEmpty(res);
    }
    throw new HttpError(405, "Method not allowed");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cross-site request guard
//
// No auth (LAN-only), but any web page open in a LAN browser could still fire
// "simple" cross-origin POSTs (text/plain, no preflight) at the API, e.g. a
// replace import that wipes the collection. Reject state-changing requests
// that a browser marks as cross-site, and require the content types the SPA
// sends so a cross-origin request would always need a (failing) preflight.

function checkSameOrigin(req) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request refused");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused");
  } else if (origin === "null") throw new HttpError(403, "Cross-origin request refused");
}

/** Body content type must be one of `types` (only checked when there is a body). */
function requireContentType(req, ...types) {
  const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"];
  if (!hasBody) return;
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!types.includes(type)) throw new HttpError(415, `Content-Type must be ${types.join(" or ")}`);
}

// ---------------------------------------------------------------------------
// Routing

async function handleApi(req, res, url) {
  const { pathname, searchParams: query } = url;
  const method = req.method;
  let m;
  checkSameOrigin(req);
  if (restoring && method !== "GET" && method !== "HEAD") throw new HttpError(503, "A backup is being restored; try again in a moment");
  if (pathname === "/api/backups" || pathname.startsWith("/api/backups/")) {
    const handled = await handleBackupApi(req, res, url);
    if (handled !== null) return handled;
  }

  if (pathname === "/api/downloads" && method === "GET") return sendJson(res, 200, { downloads: await listDownloads(DOWNLOAD_DIR) });
  if ((m = /^\/api\/downloads\/([^/]+)$/.exec(pathname)) && (method === "GET" || method === "HEAD")) {
    let name;
    try { name = decodeURIComponent(m[1]); } catch { throw new HttpError(400, "Not a download name"); }
    let file;
    try { file = await downloadPath(DOWNLOAD_DIR, name); } catch (err) { throw err instanceof DownloadError ? new HttpError(err.status, err.message) : err; }
    const info = await stat(file);
    res.writeHead(200, {
      "Content-Type": APK_TYPE,
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    if (method === "HEAD") return res.end();
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    return stream.pipe(res);
  }

  if (pathname === "/api/stats" && method === "GET") {
    // ?binder= restricts the counts and value to that binder (exact, case-insensitive; '' = Unsorted).
    return sendJson(res, 200, stats(db, { binder: query.has("binder") ? query.get("binder").slice(0, 200) : null }));
  }
  if (pathname === "/api/query-help" && method === "GET") return sendJson(res, 200, { help: QUERY_HELP });
  if (pathname === "/api/collection" && method === "GET") return sendJson(res, 200, collectionRows(query));
  if ((m = /^\/api\/cards\/([0-9a-f-]{36})$/i.exec(pathname)) && method === "GET") {
    return sendJson(res, 200, cardDetail(m[1].toLowerCase()));
  }
  if (pathname.startsWith("/api/cards/") && method === "GET") throw new HttpError(404, "Card not found");

  if (pathname === "/api/import/manabox" && method === "POST") {
    const mode = query.get("mode") || defaultImportMode(db);
    if (!IMPORT_MODES.includes(mode)) throw new HttpError(400, 'mode must be "replace", "delta" or "add"');
    // Once the app is the collection master, a replace would undo nothing the
    // app manages (source app/scan) but still wipes every ManaBox row: ask first.
    if (mode === "replace" && collectionMaster(db) === "app" && query.get("confirm_replace") !== "1") {
      req.resume();
      throw new HttpError(409, "mtg-planner is the master of your collection: a replace import deletes every card imported from ManaBox " +
        "and loads the file instead (cards you scanned or moved in the app stay, and moved copies are not loaded a second time). Confirm with confirm_replace=1, or import with mode=delta.",
        { code: "confirm_replace" });
    }
    const filename = (query.get("filename") || "").slice(0, 255) || null;
    // binder (optional): put every card of this import into one binder; present but empty =
    // Unsorted. A binder that doesn't exist yet needs create_binder=1 (a typo shouldn't make one).
    let targetBinder = null;
    if (query.has("binder")) {
      const name = String(query.get("binder")).trim();
      if (name.length > MAX_BINDER_NAME) throw new HttpError(400, `Binder name is too long (max ${MAX_BINDER_NAME})`);
      targetBinder = name ? findBinder(db, name) : "";
      if (targetBinder == null) {
        if (query.get("create_binder") !== "1") { req.resume(); throw new HttpError(404, `Binder "${name}" not found (send create_binder=1 to create it)`); }
        targetBinder = name;
      }
    }
    // text/csv is not a CORS-safelisted type; text/plain is accepted only with
    // the SPA's X-Requested-With header (which also forces a preflight).
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!(type === "text/csv" || (type === "text/plain" && req.headers["x-requested-with"]))) {
      throw new HttpError(415, "Content-Type must be text/csv");
    }
    const buf = await readBody(req, CSV_LIMIT);
    const text = buf.toString("utf8");
    if (!text.trim()) throw new HttpError(400, "The CSV file is empty.");
    const since = sqlNow();
    const summary = await exclusive(() => importManaBoxCsv(db, text, { mode, filename, targetBinder }).catch((err) => { throw importError(err); }));
    scheduleChangedDecks(since); // rebuilt ManaBox decks
    return sendJson(res, 200, summary);
  }
  if (pathname === "/api/settings") {
    if (method === "GET") return sendJson(res, 200, { collection_master: collectionMaster(db), ...spellbookSettingsView() });
    if (method === "PATCH") {
      const body = await readJson(req);
      const patch = {};
      if (body.spellbook_enabled !== undefined) {
        if (typeof body.spellbook_enabled !== "boolean") throw new HttpError(400, "spellbook_enabled must be true or false");
        if (body.spellbook_enabled && spellbookSettings(db).env_disabled) {
          throw new HttpError(409, "The combo check is turned off on the server (SPELLBOOK_ENABLED=false)");
        }
        patch.enabled = body.spellbook_enabled;
      }
      // Where the card names go is a server setting only (env SPELLBOOK_URL), never a LAN request.
      if (body.spellbook_url !== undefined) throw new HttpError(400, "The Commander Spellbook URL can only be set on the server (SPELLBOOK_URL)");
      if (body.collection_master !== undefined) scanCall(() => setCollectionMaster(db, body.collection_master));
      if (Object.keys(patch).length) {
        try { setSpellbookSettings(db, patch); } catch (err) { throw err instanceof SpellbookError ? new HttpError(err.status ?? 400, err.message) : err; }
      }
      return sendJson(res, 200, { collection_master: collectionMaster(db), ...spellbookSettingsView() });
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (pathname === "/api/collection/move" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, await exclusive(async () => scanCall(() => moveCopies(db, body))));
  }
  // Edit / delete owned copies, the edit log and its undo (lib/edits.js). Like moves they wait
  // for imports and price refreshes (exclusive) and run in one transaction each.
  if (pathname === "/api/collection/edit" && method === "POST") {
    const body = await readJson(req);
    if (body.actor !== undefined && body.actor !== "app") throw new HttpError(400, 'actor must be "app"');
    return sendJson(res, 200, await exclusive(() => editCopies(db, {
      items: body.items, set: body.set, confirm_master: body.confirm_master === true, actor: "app",
    }, { getPrinting: editPrintingLookup() }).catch((err) => { throw scanErr(err); })));
  }
  if (pathname === "/api/collection/delete" && method === "POST") {
    const body = await readJson(req);
    if (body.actor !== undefined && body.actor !== "app") throw new HttpError(400, 'actor must be "app"');
    return sendJson(res, 200, await exclusive(async () => scanCall(() => deleteCopies(db, {
      items: body.items, confirm: body.confirm, expected_copies: body.expected_copies ?? null,
      confirm_master: body.confirm_master === true, actor: "app",
    }))));
  }
  if (pathname === "/api/collection/edits" && method === "GET") {
    return sendJson(res, 200, { edits: listEdits(db, { limit: query.get("limit") || 50 }) });
  }
  if ((m = /^\/api\/collection\/edits\/(\d+)\/undo$/.exec(pathname))) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const id = Number(m[1]);
    return sendJson(res, 200, await exclusive(async () => scanCall(() => undoEdit(db, id))));
  }
  if (pathname === "/api/maintenance/relanguage-scans" && method === "POST") {
    const body = await readJson(req);
    const dryRun = body.dry_run === undefined ? true : body.dry_run;
    return sendJson(res, 200, await exclusive(() => relanguageScans(db, { scan_ids: body.scan_ids, dry_run: dryRun }, {
      getPrinting: editPrintingLookup(),
    }).catch((err) => { throw scanErr(err); })));
  }
  if (pathname === "/api/refresh-prices" && method === "POST") {
    const result = await exclusive(() => refreshOwnedCards(db).catch((err) => { throw importError(err); }));
    setAppMeta(db, "last_price_refresh", new Date().toISOString());
    return sendJson(res, 200, result);
  }
  if (pathname === "/api/imports" && method === "GET") {
    const rows = db.prepare("SELECT id, kind, filename, mode, summary, created_at FROM imports ORDER BY id DESC LIMIT 20").all();
    return sendJson(res, 200, rows.map((r) => ({ ...r, summary: parseJsonField(r.summary, {}) })));
  }

  if (pathname === "/api/decks") {
    if (method === "GET") {
      const decks = listDecks(db);
      for (const d of decks) if (d.spellbook_request) spellbook.ensure(d.spellbook_request);
      return sendJson(res, 200, decks);
    }
    if (method === "POST") return sendJson(res, 201, await createDeck(req));
  }
  if (pathname === "/api/decks/evaluate") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    return sendJson(res, 200, await evaluateDeck(req));
  }
  // Global shopping list: built decks' shortage + per deck (lib/decks.js) + the wishlist's open items.
  if (pathname === "/api/shopping-list" && method === "GET") return sendJson(res, 200, { ...shoppingList(db), wishlist: wishlistShopping(db) });
  if (pathname === "/api/wishlist" || pathname.startsWith("/api/wishlist/")) return handleWishlistApi(req, res, url);
  if (pathname.startsWith("/api/finance/")) return handleFinanceApi(req, res, url);
  if ((m = /^\/api\/decks\/(\d+)\/(cards|commander|to-binder|status-preview|combos)$/.exec(pathname))) {
    const id = Number(m[1]);
    if (m[2] === "combos" && method === "POST") return sendJson(res, 202, postDeckCombos(id));
    if (m[2] === "status-preview" && method === "GET") return sendJson(res, 200, statusPreview(id, query.get("status") || "built"));
    if (m[2] === "cards" && method === "PATCH") return sendJson(res, 200, await patchDeckCard(req, id));
    if (m[2] === "commander" && method === "POST") return sendJson(res, 200, await postCommander(req, id));
    if (m[2] === "to-binder" && method === "POST") return sendJson(res, 200, await postDeckToBinder(req, id));
    throw new HttpError(405, "Method not allowed");
  }
  if ((m = /^\/api\/decks\/(\d+)(\/export)?$/.exec(pathname))) {
    const id = Number(m[1]);
    if (m[2]) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const detail = getDeckOr404(id);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": exportFilename(detail.name),
        "Cache-Control": "no-store",
      });
      return res.end(exportDeck(detail));
    }
    if (method === "GET") return sendJson(res, 200, getDeckOr404(id));
    if (method === "PATCH") return sendJson(res, 200, await patchDeck(req, id));
    if (method === "DELETE") {
      const info = db.prepare("DELETE FROM decks WHERE id = ?").run(id);
      if (!info.changes) throw new HttpError(404, "Deck not found");
      return sendEmpty(res);
    }
  }

  if (pathname === "/api/chats") {
    if (method === "GET") {
      return sendJson(res, 200, db.prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC, created_at DESC, rowid DESC").all());
    }
    if (method === "POST") {
      const body = await readJson(req);
      const title = optString(body.title, "title", 200) || "New chat";
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(id, title);
      return sendJson(res, 201, db.prepare("SELECT id, title, created_at, updated_at FROM chats WHERE id = ?").get(id));
    }
  }
  if ((m = /^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/i.exec(pathname))) {
    const id = m[1].toLowerCase();
    if (m[2]) {
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      return postMessage(req, res, id);
    }
    if (method === "GET") {
      const chat = getChatOr404(id);
      const messages = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(id).map(messageRow);
      const { session_id, ...publicChat } = chat;
      return sendJson(res, 200, { chat: publicChat, messages, busy: runs.has(id) });
    }
    if (method === "DELETE") {
      runs.get(id)?.abort();
      const info = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
      if (!info.changes) throw new HttpError(404, "Chat not found");
      return sendEmpty(res);
    }
  }
  if (pathname.startsWith("/api/chats/")) throw new HttpError(404, "Chat not found");

  if (/^\/api\/(scan|scans|printings|binders|index|calibration)(\/|$)/.test(pathname)) {
    const handled = await handleScanApi(req, res, url);
    if (handled !== null) return handled;
  }
  if (pathname.startsWith("/api/debug/")) return handleDebugApi(req, res, url);

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Wishlist (lib/wishlist.js) and value history (lib/finance.js)

const wishCall = async (fn) => {
  try { return await fn(); } catch (err) { throw err instanceof WishlistError ? new HttpError(err.status, err.message) : err; }
};

// GET /api/wishlist → {items, totals}; POST {scryfall_id|oracle_id|name, set?, collector_number?, any_printing?, finish?,
// language?, quantity?, max_price_eur?, note?, priority?} → 201 {item, merged} (200 when merged into an existing item);
// PATCH /api/wishlist/:id {quantity?, max_price_eur?, note?, priority?, finish?, language?, any_printing?} → item;
// DELETE /api/wishlist/:id → 204. Not inside exclusive(): no collection rows change (a missing card row is fetched).
async function handleWishlistApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  if (pathname === "/api/wishlist") {
    if (method === "GET") return sendJson(res, 200, listWishlist(db));
    if (method === "POST") {
      const body = await readJson(req);
      if (body.source !== undefined && body.source !== "app") throw new HttpError(400, 'source must be "app"');
      const out = await wishCall(() => addWishlistItem(db, body, { source: "app" }));
      scheduleSnapshot();
      return sendJson(res, out.merged ? 200 : 201, out);
    }
    throw new HttpError(405, "Method not allowed");
  }
  const m = /^\/api\/wishlist\/(\d+)$/.exec(pathname);
  if (!m) throw new HttpError(404, "Wishlist item not found");
  const id = Number(m[1]);
  if (method === "GET") {
    const item = getWishlistItem(db, id);
    if (!item) throw new HttpError(404, "Wishlist item not found");
    return sendJson(res, 200, item);
  }
  if (method === "PATCH") {
    const body = await readJson(req);
    const item = await wishCall(() => updateWishlistItem(db, id, body));
    scheduleSnapshot();
    return sendJson(res, 200, item);
  }
  if (method === "DELETE") {
    if (!deleteWishlistItem(db, id)) throw new HttpError(404, "Wishlist item not found");
    scheduleSnapshot();
    return sendEmpty(res);
  }
  throw new HttpError(405, "Method not allowed");
}

// Value tab, all GET: /api/finance/summary (live totals, today/7d/30d change split into added / removed /
// price changes, per binder + rarity), /history?days=90 (daily totals), /movers?days=7&limit=10 (risers and
// fallers among cards held throughout), /top?limit=20 (most valuable printings + binders),
// /card/:scryfall_id?finish= (one printing's stored price/quantity changes).
function handleFinanceApi(req, res, url) {
  const { pathname, searchParams: query } = url;
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (pathname === "/api/finance/summary") return sendJson(res, 200, financeSummary(db));
  if (pathname === "/api/finance/history") return sendJson(res, 200, financeHistory(db, { days: query.get("days") || 90 }));
  if (pathname === "/api/finance/movers") return sendJson(res, 200, financeMovers(db, { days: query.get("days") || 7, limit: query.get("limit") || 10 }));
  if (pathname === "/api/finance/top") return sendJson(res, 200, financeTop(db, { limit: query.get("limit") || 20 }));
  const m = /^\/api\/finance\/card\/([0-9a-f-]{36})$/i.exec(pathname);
  if (m) {
    const finish = query.get("finish") || "normal";
    if (!["normal", "foil", "etched"].includes(finish)) throw new HttpError(400, "finish must be normal, foil or etched");
    return sendJson(res, 200, { scryfall_id: m[1].toLowerCase(), finish, points: cardHistory(db, m[1].toLowerCase(), finish) });
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// Static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

async function fileInfo(file) {
  try {
    const s = await stat(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "Bad path"); }
  if (rel.includes("\0")) throw new HttpError(400, "Bad path");
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.join(STATIC_DIR, path.normalize(rel));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) throw new HttpError(404, "Not found");

  let info = await fileInfo(file);
  if (!info) {
    // SPA fallback for route-like paths; missing assets stay 404.
    if (path.extname(rel) && path.extname(rel) !== ".html") throw new HttpError(404, "Not found");
    file = path.join(STATIC_DIR, "index.html");
    info = await fileInfo(file);
    if (!info) throw new HttpError(404, "Not found");
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Server

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.on("close", () => {
    const aborted = res.writableFinished ? "" : " (client closed)";
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms${aborted}`);
  });

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "Bad request URL" });
  }

  try {
    if (url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true, version: VERSION, claude_configured: claudeConfigured(), claude_cli: claudeCliHealth(), scanner: await scannerHealth(),
        spellbook: spellbookHealthz(), card_facts: cardFactsHealth(),
      });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(`[error] ${req.method} ${req.url}:`, err);
    else if (status >= 500) console.warn(`[warn] ${req.method} ${req.url}: ${err.message}`);
    if (res.headersSent) {
      // e.g. an SSE stream already started: report in-band and close.
      try { if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`); } catch { /* ignore */ }
      return;
    }
    // Drain any unread body so the connection can be reused.
    req.resume();
    sendJson(res, status, { ...(err instanceof HttpError && err.extra ? err.extra : {}), error: status === 500 ? `Internal error: ${err.message}` : err.message });
  }
});

server.requestTimeout = 0; // SSE turns and large imports can take minutes
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

// ---------------------------------------------------------------------------
// Nightly maintenance (lib/scheduler.js): index refresh + fingerprints, prices.

const scheduler = createScheduler({
  config: schedulerConfig(),
  meta: { get: (k) => getAppMeta(db, k), set: (k, v) => setAppMeta(db, k, v) },
  indexInfo: () => {
    if (!idx) return null;
    const st = indexBrief(idx);
    return { printings: st.printings, last_refresh: st.last_refresh, bulk_updated_at: st.bulk_updated_at };
  },
  indexBusy: () => Boolean(indexJob.running),
  remoteBulkUpdatedAt: async () => (await fetchBulkInfo()).updated_at,
  runIndexRefresh: async () => { await startIndexJob("refresh", { then: "fingerprints" })[JOB_DONE]; },
  runPriceRefresh: () => exclusive(() => refreshOwnedCards(db)),
  // Daily value snapshot (after the prices); waits out an import like the debounced one.
  runSnapshot: async () => {
    for (let i = 0; (importBusy || restoring) && i < 60; i++) await new Promise((r) => setTimeout(r, 5000));
    return snapshotValue(db);
  },
  checkpoint: () => { if (idx && !indexJob.running) checkpointIndex(idx); },
});

prepareMcpConfig();
// Spellbook settings live in meta (shared with the MCP process); the env seeds them and its "false" always wins.
try {
  seedSpellbookSettings(db, process.env, console);
  const pruned = pruneSpellbookCache(db);
  if (pruned) console.log(`[spellbook] pruned ${pruned} cache entries unused for 60 days`);
} catch (err) {
  console.warn(`[spellbook] ${err.message}`);
}
// First commit after boot creates the app DB's WAL file (one fsync, ~60 ms
// on a spinning disk): pay it here instead of in the first scan's staging.
try { setAppMeta(db, "last_start", new Date().toISOString()); } catch (err) { console.warn(`[db] ${err.message}`); }
// Day 0 of the value history (Value tab): today's snapshot from the current prices when there is none.
try {
  const seeded = ensureSnapshot(db);
  if (seeded) console.log(`[finance] value snapshot ${seeded.day}: €${seeded.value_eur.toFixed(2)}, ${seeded.copies} copies`);
} catch (err) { console.warn(`[finance] ${err.message}`); }
autoIndex();
scheduler.start();
server.listen(PORT, () => {
  console.log(`mtg-planner ${VERSION} listening on :${PORT} (static: ${STATIC_DIR}, claude: ${claudeConfigured() ? "configured" : "not configured"})`);
  // CARD_FACTS_DELAY_MS: tests only (default 30 s after start).
  scheduleCardFacts(Number(process.env.CARD_FACTS_DELAY_MS) >= 0 && process.env.CARD_FACTS_DELAY_MS ? Number(process.env.CARD_FACTS_DELAY_MS) : 30000);
  // Preload the fingerprints now so the first scan doesn't pay for it.
  if (matcher instanceof MatcherWorker) {
    matcher.start();
    matcher.whenReady(10 * 60 * 1000).then((ok) => {
      const st = matcher.status();
      if (ok) console.log(`[scanner] matcher ready: ${st.size} fingerprints, load ${st.load_ms} ms, ready after ${st.ready_ms} ms${st.backfill ? ` (backfilled ${st.backfill.updated} in ${st.backfill.ms} ms)` : ""}`);
      scheduleEnglishPrices();
    });
  } else {
    scheduleEnglishPrices(5000);
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  scheduler.stop();
  spellbook.close();
  clearTimeout(cardFactsTimer);
  clearTimeout(snapshotTimer);
  for (const controller of runs.values()) controller.abort();
  indexJob.controller?.abort();
  killAll();
  if (matcher instanceof MatcherWorker) matcher.close().catch(() => {});
  // Give aborted runs a moment to store their partial answers, then close.
  const deadline = Date.now() + 8000;
  const timer = setInterval(() => {
    if (runs.size === 0 || Date.now() > deadline) {
      clearInterval(timer);
      server.closeAllConnections();
      try { db.close(); } catch { /* ignore */ }
      try { idx?.close(); } catch { /* ignore */ }
      process.exit(0);
    }
  }, 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
