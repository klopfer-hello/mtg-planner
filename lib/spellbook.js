// Commander Spellbook client: two-card combos, Game Changer / mass land
// denial / extra-turn flags and Spellbook's own bracket tag for a commander
// deck, from POST https://backend.commanderspellbook.com/estimate-bracket.
//
// Why it looks like this:
// - It is the app's only network input for deck power, so it must never sit
//   on the request path: deckDetail only READS the cache (cachedCombos); the
//   server (and the MCP process, against its own connection) fills it in the
//   background with no lock held, then writes one short statement against
//   the db handle that is current at write time, skipped while a restore runs.
// - Only card names and quantities leave the process (user decision): the
//   English cards.name for resolved rows, the typed deck_cards.name otherwise.
//   Names Spellbook doesn't know are dropped silently on its side; we report
//   them as `unresolved` ("n cards not checked"), with no other retry.
// - Multi-face names: a recorded probe (test/fixtures/spellbook-estimate-*.json,
//   2026-10-15) showed that `A // B` resolves for MDFC, split, adventure and
//   flip cards while the front face alone does NOT. So the full name is sent;
//   an unresolved row typed as a front face is mapped to its full name from
//   the local cards table (deckPayloadRows), never by another network call.
// - Two processes (server, per-turn MCP) share one rate budget: a slot is
//   reserved atomically in the app meta table (BEGIN IMMEDIATE) before every
//   call, ≥1.5 s apart (API guidance: "80 requests per minute should be a
//   safe rate"), with backoff after a 429 (Retry-After or 60 s) or a network
//   error/5xx/timeout (5 min).
// - Settings live in meta so both processes obey the same opt-out; the env
//   SPELLBOOK_ENABLED=false always wins.
// - The cache key is a hash of the normalised (board, name, quantity) lines,
//   so identical decks share an entry and a reordered deck is a cache hit.

import { createHash } from "node:crypto";
import { getAppMeta, parseJson, setAppMeta } from "./db.js";

/**
 * Version of the trimmed result shape stored in spellbook_cache.parser (2:
 * combos carry `battlefield`; older entries are refetched).
 */
export const SPELLBOOK_PARSER = 2;
export const SPELLBOOK_DEFAULT_URL = "https://backend.commanderspellbook.com/estimate-bracket";
export const SPELLBOOK_DEFAULTS = Object.freeze({ enabled: true, url: SPELLBOOK_DEFAULT_URL, timeout_ms: 10000, ttl_days: 14 });

const SETTINGS_KEY = "spellbook_settings";
const META_LAST_CALL = "spellbook_last_call"; // ms epoch of the last reserved slot
const META_BACKOFF = "spellbook_backoff_until"; // ms epoch
const META_LAST_OK = "spellbook_last_ok"; // ISO
const META_LAST_ERROR = "spellbook_last_error"; // JSON {at, status, message}

/** Minimum spacing between two calls from any process (≤ 40/min). */
export const SPACING_MS = 1500;
export const BACKOFF_429_MS = 60_000;
export const BACKOFF_ERROR_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** An error row (no result) is retried after this long. */
const ERROR_RETRY_MS = 10 * 60_000;
/** last_used_at is refreshed at most this often per entry (it drives the prune). */
const TOUCH_MS = 24 * 3600_000;
export const PRUNE_UNUSED_DAYS = 60;
/** At most this many cache entries are kept (least recently used go first). */
export const MAX_CACHE_ROWS = 1000;
/** Schema caps of DeckRequest. */
export const MAX_COMMANDERS = 12;
export const MAX_MAIN = 600;
const MAX_NAME = 256;
const MAX_COMBOS = 60;
const MAX_PRODUCES = 6;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Spellbook's bracket tags (BracketTagEnum) and their labels. */
export const SPELLBOOK_TAGS = Object.freeze({ R: "Ruthless", S: "Spicy", P: "Powerful", O: "Oddball", C: "Core", E: "Exhibition", B: "Banned" });
const TAG_BRACKET = { R: 4, S: 3, P: 3, O: 2, C: 2, E: 1, B: "banned" };

/** Spellbook tag → our bracket scale (R 4, S/P 3, O/C 2, E 1, B 'banned'); unknown → null. */
export function tagToBracket(tag) {
  return Object.hasOwn(TAG_BRACKET, tag ?? "") ? TAG_BRACKET[tag] : null;
}

/** Failure of a Spellbook call or settings change: status (HTTP or 0 = network), retryAfterMs. */
export class SpellbookError extends Error {
  constructor(message, { status = 0, retryAfterMs = null } = {}) {
    super(message);
    this.name = "SpellbookError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Names

const fold = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[’‘`]/g, "'")
  .replace(/\s+/g, " ").trim().toLowerCase();

/** Name compare form: lowercase, NFKD without diacritics, front face before ' // '. */
export function normName(name) {
  return fold(String(name ?? "").split(" // ")[0]);
}

// ---------------------------------------------------------------------------
// Settings (meta spellbook_settings, shared by the server and the MCP process)

const isFalse = (v) => /^(false|0|no|off)$/i.test(String(v ?? "").trim());
/** True when the env turns Spellbook off (SPELLBOOK_ENABLED=false|0|no|off). */
export const envDisabled = (env = process.env) => isFalse(env?.SPELLBOOK_ENABLED);

function checkSetting(key, value) {
  switch (key) {
    case "enabled":
      if (typeof value !== "boolean") throw new SpellbookError("enabled must be true or false", { status: 400 });
      return value;
    case "url": {
      let u;
      try { u = new URL(String(value)); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.search || String(value).length > 500) throw new SpellbookError("url must be an http(s) URL without a query", { status: 400 });
      return u.href;
    }
    case "timeout_ms":
      if (!Number.isInteger(value) || value < 1000 || value > 60000) throw new SpellbookError("timeout_ms must be an integer 1000-60000", { status: 400 });
      return value;
    case "ttl_days":
      if (!Number.isInteger(value) || value < 1 || value > 365) throw new SpellbookError("ttl_days must be an integer 1-365", { status: 400 });
      return value;
    default:
      throw new SpellbookError(`unknown setting ${key}`, { status: 400 });
  }
}

function storedSettings(db) {
  const raw = parseJson(getAppMeta(db, SETTINGS_KEY));
  const out = {};
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(SPELLBOOK_DEFAULTS)) {
      if (raw[k] === undefined) continue;
      try { out[k] = checkSetting(k, raw[k]); } catch { /* ignore a bad stored value */ }
    }
  }
  return out;
}

/**
 * Effective settings {enabled, url, timeout_ms, ttl_days, env_disabled}: meta
 * over the defaults; env SPELLBOOK_ENABLED=false forces enabled false (the MCP
 * process treats disabled-in-env OR disabled-in-meta as disabled).
 */
export function spellbookSettings(db, env = process.env) {
  const s = { ...SPELLBOOK_DEFAULTS, ...storedSettings(db) };
  const off = envDisabled(env);
  return { ...s, enabled: s.enabled && !off, env_disabled: off };
}

/** Change settings (validated subset of enabled/url/timeout_ms/ttl_days; 400 SpellbookError on bad input). */
export function setSpellbookSettings(db, patch = {}, env = process.env) {
  const next = storedSettings(db);
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === "env_disabled") continue;
    next[k] = checkSetting(k, v);
  }
  setAppMeta(db, SETTINGS_KEY, JSON.stringify({ ...SPELLBOOK_DEFAULTS, ...next }));
  return spellbookSettings(db, env);
}

function envSetting(env, key) {
  const name = { enabled: "SPELLBOOK_ENABLED", url: "SPELLBOOK_URL", timeout_ms: "SPELLBOOK_TIMEOUT_MS", ttl_days: "SPELLBOOK_TTL_DAYS" }[key];
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === "") return undefined;
  try {
    if (key === "enabled") return checkSetting(key, !isFalse(raw));
    if (key === "url") return checkSetting(key, String(raw).trim());
    return checkSetting(key, Number(raw));
  } catch {
    return undefined;
  }
}

/** The user's stored opt-out: true when meta spellbook_settings says enabled=false (the env is ignored). */
export function spellbookOptedOut(db) {
  try { return storedSettings(db).enabled === false; } catch { return false; }
}

/**
 * Boot (and after a restore): fill missing settings keys from the env
 * (SPELLBOOK_ENABLED/TIMEOUT_MS/TTL_DAYS) or the defaults, and write
 * enabled=false whenever the env disables Spellbook (it always wins) or
 * `keepOff` is set (a restore carries the user's opt-out over a backup that
 * has the check on or no setting at all). The URL is server-only: it is
 * always SPELLBOOK_URL or the default, never a stored value (the HTTP API
 * can't change it). Returns the effective settings.
 */
export function seedSpellbookSettings(db, env = process.env, log = console, { keepOff = false } = {}) {
  const stored = storedSettings(db);
  const next = { ...stored };
  delete next.url;
  for (const k of Object.keys(SPELLBOOK_DEFAULTS)) {
    if (next[k] !== undefined) continue;
    const v = envSetting(env, k);
    if (v === undefined && env?.[{ url: "SPELLBOOK_URL", timeout_ms: "SPELLBOOK_TIMEOUT_MS", ttl_days: "SPELLBOOK_TTL_DAYS" }[k]]) {
      log?.warn?.(`[spellbook] ignoring invalid env for ${k}`);
    }
    next[k] = v ?? SPELLBOOK_DEFAULTS[k];
  }
  if (envDisabled(env) || keepOff) next.enabled = false;
  setAppMeta(db, SETTINGS_KEY, JSON.stringify(next));
  return spellbookSettings(db, env);
}

// ---------------------------------------------------------------------------
// Request (card names only)

/**
 * The deck rows a request is built from: deck_cards columns (board, name,
 * quantity, scryfall_id, companion when the column exists) plus card_name =
 * the printing's English cards.name, and full_name for an unresolved row
 * typed as a front face whose `A // B` card is in the local cards table.
 */
export function deckPayloadRows(db, deckId) {
  const rows = db.prepare(
    `SELECT dc.*, c.name AS card_name FROM deck_cards dc LEFT JOIN cards c ON c.scryfall_id = dc.scryfall_id
      WHERE dc.deck_id = ? ORDER BY dc.board, dc.name`,
  ).all(deckId);
  const full = db.prepare(
    "SELECT name FROM cards WHERE name LIKE ? ESCAPE '\\' ORDER BY fetched_at DESC LIMIT 1",
  );
  for (const r of rows) {
    if (r.card_name || String(r.name).includes(" // ")) continue;
    const pattern = String(r.name).replace(/[\\%_]/g, (m) => "\\" + m) + " // %";
    const hit = full.get(pattern);
    if (hit) r.full_name = hit.name;
  }
  return rows;
}

const SENT_BOARDS = { commander: "commanders", main: "main" };

/**
 * Build the estimate-bracket request for a commander deck's rows (null when
 * not a commander deck or nothing to send). Only commander + main rows are
 * sent (never side, maybe or a companion), aggregated per name, capped at
 * 12/600 entries. Returns {body:{commanders, main}, unknownCommanders, key,
 * names (sent names), truncated}. Each entry is exactly {card, quantity}.
 */
export function spellbookRequest(rows, { isCommander = false } = {}) {
  if (!isCommander) return null;
  const lists = { commanders: new Map(), main: new Map() };
  for (const r of rows ?? []) {
    const list = SENT_BOARDS[r?.board];
    if (!list || r.companion) continue;
    const qty = Math.trunc(Number(r.quantity));
    if (!(qty >= 1)) continue;
    const name = String((r.scryfall_id && r.card_name) || r.full_name || r.name || "").trim();
    if (!name || name.length > MAX_NAME) continue;
    const k = fold(name);
    const prev = lists[list].get(k);
    lists[list].set(k, { card: prev?.card ?? name, quantity: (prev?.quantity ?? 0) + qty });
  }
  const commanders = [...lists.commanders.values()];
  const main = [...lists.main.values()];
  if (!commanders.length && !main.length) return null;
  const truncated = commanders.length > MAX_COMMANDERS || main.length > MAX_MAIN;
  const body = {
    commanders: commanders.slice(0, MAX_COMMANDERS).map(({ card, quantity }) => ({ card, quantity })),
    main: main.slice(0, MAX_MAIN).map(({ card, quantity }) => ({ card, quantity })),
  };
  return {
    body,
    unknownCommanders: body.commanders.length === 0,
    key: cacheKey(body),
    names: [...body.commanders, ...body.main].map((e) => e.card),
    truncated,
  };
}

/** Cache key: sha256 of the sorted 'C|name|qty' / 'M|name|qty' lines (normalised names). */
export function cacheKey(body) {
  const lines = [
    ...(body?.commanders ?? []).map((e) => `C|${fold(e.card)}|${e.quantity}`),
    ...(body?.main ?? []).map((e) => `M|${fold(e.card)}|${e.quantity}`),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Response

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === "string" && x ? x : null);
const int = (x) => (Number.isFinite(x) ? Math.trunc(x) : null);
const COMBO_FLAGS = ["definitelyTwoCard", "arguablyTwoCard", "relevant", "borderlineRelevant", "lock", "extraTurn",
  "massLandDenial", "skipTurns", "controlAllOpponents", "controlSomeOpponents"];

const comboRank = (c) => [
  c.relevant || c.borderlineRelevant ? 0 : 1,
  c.definitelyTwoCard ? 0 : c.arguablyTwoCard ? 1 : 2,
  c.manaValueNeeded ?? 99,
];

/**
 * Trim an EstimateBracketResult to what the app uses (defensive: unknown tag
 * → null, missing fields → defaults). `sentNames` gives `unresolved` = sent
 * names Spellbook did not return (normalised compare). Combos are ordered
 * relevant/two-card/cheap first and capped (combos_total keeps the count).
 * Each combo keeps `battlefield` = the pieces that must already be on the
 * battlefield (zoneLocations has 'B'): Spellbook's manaValueNeeded leaves
 * their cost out (it is only the mana spent during the combo and for pieces
 * cast from hand), so lib/power.js adds their mana value to get the cost of
 * assembling the combo.
 */
export function trimResult(raw, sentNames = []) {
  const tagRaw = str(raw?.bracketTag);
  const out = {
    parser: SPELLBOOK_PARSER,
    tag: tagRaw && Object.hasOwn(SPELLBOOK_TAGS, tagRaw) ? tagRaw : null,
    gc: [], mld: [], extra_turns: [], banned: [], combos: [], combos_total: 0, unresolved: [],
  };
  const returned = new Set();
  for (const c of arr(raw?.cards)) {
    const name = str(c?.card?.name);
    if (!name) continue;
    returned.add(normName(name));
    if (c.gameChanger === true) out.gc.push(name);
    if (c.massLandDenial === true) out.mld.push(name);
    if (c.extraTurn === true) out.extra_turns.push(name);
    if (c.banned === true) out.banned.push(name);
  }
  const combos = [];
  for (const v of arr(raw?.combos)) {
    const combo = v?.combo ?? {};
    const id = combo.id == null ? null : String(combo.id).slice(0, 100);
    const cards = arr(combo.uses).map((u) => str(u?.card?.name)).filter(Boolean);
    if (!id || !cards.length) continue;
    const item = {
      id,
      cards,
      produces: arr(combo.produces).map((p) => str(p?.feature?.name)).filter(Boolean).slice(0, MAX_PRODUCES),
      manaValueNeeded: int(combo.manaValueNeeded),
      battlefield: arr(combo.uses).filter((u) => arr(u?.zoneLocations).includes("B")).map((u) => str(u?.card?.name)).filter(Boolean),
      speed: int(v.speed),
    };
    for (const f of COMBO_FLAGS) item[f] = v[f] === true;
    combos.push(item);
  }
  combos.sort((a, b) => {
    const ra = comboRank(a); const rb = comboRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
  out.combos_total = combos.length;
  out.combos = combos.slice(0, MAX_COMBOS);
  const seen = new Set();
  for (const n of sentNames) {
    const k = normName(n);
    if (!k || returned.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.unresolved.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP

function parseRetryAfter(value, now) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** The User-Agent naming this service (API guidance). */
export function userAgent(version = process.env.APP_VERSION || "dev") {
  return `mtg-planner/${version} (+https://github.com/klopfer-hello/mtg-planner)`;
}

/**
 * POST the request; resolves the raw JSON. Throws SpellbookError with
 * status (0 = network/timeout) and retryAfterMs for a 429.
 */
export async function fetchEstimate(request, { url = SPELLBOOK_DEFAULT_URL, timeout_ms = SPELLBOOK_DEFAULTS.timeout_ms,
  fetch: fetchFn = globalThis.fetch, version, signal, now = Date.now() } = {}) {
  const target = url + (request.unknownCommanders ? "?unknownCommanders=true" : "");
  const signals = [AbortSignal.timeout(timeout_ms), signal].filter(Boolean);
  let res;
  try {
    res = await fetchFn(target, {
      method: "POST",
      headers: { "User-Agent": userAgent(version), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ commanders: request.body.commanders, main: request.body.main }),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError";
    throw new SpellbookError(timeout ? `Spellbook timed out after ${timeout_ms} ms` : `Spellbook unreachable: ${err?.message ?? err}`, { status: 0 });
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new SpellbookError(`Spellbook HTTP ${res.status}`, {
      status: res.status,
      retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers?.get?.("retry-after"), now) : null,
    });
  }
  let text;
  try { text = await res.text(); } catch (err) { throw new SpellbookError(`Spellbook read failed: ${err?.message ?? err}`, { status: 0 }); }
  if (text.length > MAX_RESPONSE_BYTES) throw new SpellbookError("Spellbook response too large", { status: 502 });
  try {
    return JSON.parse(text);
  } catch {
    throw new SpellbookError("Spellbook answered with invalid JSON", { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// Rate state (meta, shared across processes)

const metaNum = (db, key) => {
  const v = Number(getAppMeta(db, key));
  return Number.isFinite(v) ? v : 0;
};

/**
 * Reserve the next call slot atomically (BEGIN IMMEDIATE across processes):
 * → {ok:true} after recording `now`, or {ok:false, reason: backoff|spacing|
 * busy, retry_at (ms)}. Only fetch after ok.
 */
export function reserveSlot(db, { now = Date.now(), spacingMs = SPACING_MS } = {}) {
  if (db.isTransaction) return { ok: false, reason: "busy", retry_at: now + spacingMs };
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return { ok: false, reason: "busy", retry_at: now + spacingMs };
  }
  try {
    const backoff = metaNum(db, META_BACKOFF);
    const last = metaNum(db, META_LAST_CALL);
    let verdict;
    if (backoff > now) verdict = { ok: false, reason: "backoff", retry_at: backoff };
    else if (last && now - last < spacingMs && last <= now) verdict = { ok: false, reason: "spacing", retry_at: last + spacingMs };
    else {
      setAppMeta(db, META_LAST_CALL, now);
      verdict = { ok: true };
    }
    db.exec("COMMIT");
    return verdict;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    return { ok: false, reason: "busy", retry_at: now + spacingMs, error: err.message };
  }
}

/** ms epoch until which no call is made (0 = none). */
export function backoffUntil(db) {
  try { return metaNum(db, META_BACKOFF); } catch { return 0; }
}

function noteFailure(db, err, now) {
  const status = err?.status ?? 0;
  let wait = 0;
  if (status === 429) wait = Math.min(err.retryAfterMs ?? BACKOFF_429_MS, BACKOFF_MAX_MS) || BACKOFF_429_MS;
  else if (status === 0 || status >= 500) wait = BACKOFF_ERROR_MS;
  if (wait > 0) setAppMeta(db, META_BACKOFF, Math.max(metaNum(db, META_BACKOFF), now + wait));
  setAppMeta(db, META_LAST_ERROR, JSON.stringify({ at: new Date(now).toISOString(), status, message: String(err?.message ?? err).slice(0, 300) }));
}

// ---------------------------------------------------------------------------
// Cache (spellbook_cache; created by migration v9)

const iso = (ms) => new Date(ms).toISOString();

function readRow(db, key) {
  return db.prepare("SELECT * FROM spellbook_cache WHERE key = ?").get(key) ?? null;
}

/** A failure that sets the shared backoff (429, network/timeout, 5xx); other 4xx don't. */
const backsOff = (status) => status === 429 || status === 0 || status >= 500;

function writeEntry(db, key, { status, now, error = null, httpStatus = 0, tagRaw = null, result = null }) {
  // An error never overwrites a good result (stale serving). It is noted in
  // the ok row's (otherwise unused) error column as JSON {at, status,
  // message}, so a stale entry whose refetch fails with a status that sets no
  // backoff (400/404/413/422 ...) is retried only every ERROR_RETRY_MS, not on
  // every deck read.
  if (status !== "ok") {
    const noted = db.prepare("UPDATE spellbook_cache SET error = ? WHERE key = ? AND status = 'ok'")
      .run(JSON.stringify({ at: iso(now), status: httpStatus, message: error }), key);
    if (noted.changes) return;
  }
  db.prepare(
    `INSERT INTO spellbook_cache (key, fetched_at, last_used_at, status, error, tag_raw, parser, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at,
       status = excluded.status, error = excluded.error, tag_raw = excluded.tag_raw, parser = excluded.parser,
       result = excluded.result
     WHERE excluded.status = 'ok' OR spellbook_cache.status <> 'ok'`,
  ).run(key, iso(now), iso(now), status, error, tagRaw, SPELLBOOK_PARSER, result == null ? null : JSON.stringify(result));
}

/**
 * Read-only view of the cached combos for a request key (what deckDetail
 * uses): {status: ok|stale|pending|offline|disabled, fetched_at, result,
 * error, needs_fetch, retry_at}. stale = older than ttl_days but served;
 * pending = nothing cached yet (a fetch should be started); offline = in
 * backoff or the last attempt failed with nothing cached. `touch` refreshes
 * last_used_at at most daily (it drives the 60-day prune); never throws.
 */
export function cachedCombos(db, key, { settings = null, env = process.env, now = Date.now(), touch = true } = {}) {
  const s = settings ?? spellbookSettings(db, env);
  const empty = { fetched_at: null, result: null, error: null, needs_fetch: false, retry_at: null };
  if (!s.enabled) return { status: "disabled", ...empty };
  if (!key) return { status: "pending", ...empty };
  let row = null;
  try { row = readRow(db, key); } catch { row = null; }
  const backoff = backoffUntil(db);
  const retryAt = backoff > now ? backoff : null;
  const usable = row && row.status === "ok" && row.parser === SPELLBOOK_PARSER && row.result;
  const result = usable ? parseJson(row.result) : null;
  if (row && touch) {
    const used = Date.parse(row.last_used_at ?? "");
    if (!Number.isFinite(used) || now - used > TOUCH_MS) {
      try { db.prepare("UPDATE spellbook_cache SET last_used_at = ? WHERE key = ?").run(iso(now), key); } catch { /* busy/readonly: skip */ }
    }
  }
  if (result) {
    const age = now - Date.parse(row.fetched_at);
    const stale = !(age <= s.ttl_days * 86400_000);
    const failed = failedAt(row);
    const errorRetry = stale && failed != null && now - failed < ERROR_RETRY_MS ? failed + ERROR_RETRY_MS : null;
    return { status: stale ? "stale" : "ok", fetched_at: row.fetched_at, result, error: null,
      needs_fetch: stale && !retryAt && !errorRetry, retry_at: retryAt ?? errorRetry };
  }
  if (row && row.status === "error") {
    const age = now - Date.parse(row.fetched_at);
    return { status: "offline", ...empty, fetched_at: row.fetched_at, error: row.error, needs_fetch: !retryAt && !(age < ERROR_RETRY_MS), retry_at: retryAt };
  }
  return retryAt
    ? { status: "offline", ...empty, error: "Commander Spellbook is backing off", retry_at: retryAt }
    : { status: "pending", ...empty, needs_fetch: true };
}

/** ms epoch of an ok entry's last failed refetch that set no backoff (see writeEntry), or null. */
function failedAt(row) {
  if (!row || row.status !== "ok" || !row.error) return null;
  try {
    const e = JSON.parse(row.error);
    return backsOff(Number(e.status) || 0) ? null : Date.parse(e.at) || null;
  } catch {
    return null;
  }
}

const currentDb = (ctx) => (typeof ctx.db === "function" ? ctx.db() : ctx.db);
const isRestoring = (ctx) => Boolean(ctx.restoring?.());

/**
 * Fetch (unless fresh) and cache one request. ctx = {db (handle or () =>
 * current handle), restoring?: () => bool, fetch?, env?, version?, now?: () =>
 * ms, log?}. No lock is held during the call; the slot is reserved first and
 * every write is one short statement against the db current at write time,
 * skipped while restoring. Never throws: returns cachedCombos()'s shape plus
 * reason (disabled|not_commander|restoring|backoff|spacing|busy|error) when
 * nothing new was fetched, and written:false when a restore began meanwhile.
 * opts.force refetches a fresh entry (still obeys slot and backoff).
 */
export async function refreshCombos(ctx, request, { force = false } = {}) {
  const env = ctx.env ?? process.env;
  const clock = ctx.now ?? Date.now;
  const db0 = currentDb(ctx);
  if (!db0 || isRestoring(ctx)) return { status: "pending", fetched_at: null, result: null, reason: "restoring", retry_at: clock() + 5000 };
  const settings = spellbookSettings(db0, env);
  if (!settings.enabled) return { ...cachedCombos(db0, null, { settings }), reason: "disabled" };
  if (!request) return { status: "disabled", fetched_at: null, result: null, reason: "not_commander" };
  if (!force) {
    const cached = cachedCombos(db0, request.key, { settings, now: clock(), touch: false });
    if (cached.status === "ok") return cached;
    // A stale entry's last refetch failed (no backoff) less than ERROR_RETRY_MS ago: serve it.
    let failed = null;
    try { failed = failedAt(readRow(db0, request.key)); } catch { failed = null; }
    if (failed != null && clock() - failed < ERROR_RETRY_MS) return { ...cached, reason: "error", retry_at: cached.retry_at ?? failed + ERROR_RETRY_MS };
  }
  const slot = reserveSlot(db0, { now: clock() });
  if (!slot.ok) return { ...cachedCombos(db0, request.key, { settings, now: clock(), touch: false }), reason: slot.reason, retry_at: slot.retry_at };
  let raw;
  try {
    raw = await fetchEstimate(request, { url: settings.url, timeout_ms: settings.timeout_ms, fetch: ctx.fetch, version: ctx.version, now: clock() });
  } catch (err) {
    const db1 = currentDb(ctx);
    if (db1 && !isRestoring(ctx)) {
      try {
        noteFailure(db1, err, clock());
        writeEntry(db1, request.key, { status: "error", now: clock(), error: String(err.message).slice(0, 300), httpStatus: err?.status ?? 0 });
        pruneSpellbookCache(db1, { now: clock() });
      } catch (e) {
        ctx.log?.warn?.(`[spellbook] could not record failure: ${e.message}`);
      }
    }
    ctx.log?.warn?.(`[spellbook] ${err.message}`);
    const after = db1 && !isRestoring(ctx) ? cachedCombos(db1, request.key, { settings, now: clock(), touch: false }) : { status: "offline", fetched_at: null, result: null };
    return { ...after, reason: "error", error: err.message };
  }
  const result = trimResult(raw, request.names);
  const now = clock();
  const db1 = currentDb(ctx);
  if (!db1 || isRestoring(ctx)) return { status: "ok", fetched_at: iso(now), result, error: null, written: false };
  try {
    writeEntry(db1, request.key, { status: "ok", now, tagRaw: str(raw?.bracketTag)?.slice(0, 16) ?? null, result });
    setAppMeta(db1, META_LAST_OK, iso(now));
    pruneSpellbookCache(db1, { now });
  } catch (err) {
    ctx.log?.warn?.(`[spellbook] cache write failed: ${err.message}`);
    return { status: "ok", fetched_at: iso(now), result, error: null, written: false };
  }
  return { status: "ok", fetched_at: iso(now), result, error: null, written: true };
}

/**
 * Delete entries unused for `days` (default 60), then all but the `maxRows`
 * (MAX_CACHE_ROWS) most recently used; returns the number removed. Runs at
 * boot, after a restore and after every cache write (Claude's draft
 * evaluations add one entry per distinct list).
 */
export function pruneSpellbookCache(db, { days = PRUNE_UNUSED_DAYS, now = Date.now(), maxRows = MAX_CACHE_ROWS } = {}) {
  const cutoff = iso(now - days * 86400_000);
  try {
    let n = Number(db.prepare("DELETE FROM spellbook_cache WHERE COALESCE(last_used_at, fetched_at) < ?").run(cutoff).changes);
    n += Number(db.prepare(
      `DELETE FROM spellbook_cache WHERE key IN (
         SELECT key FROM spellbook_cache ORDER BY COALESCE(last_used_at, fetched_at) DESC, key LIMIT -1 OFFSET ?)`,
    ).run(maxRows).changes);
    return n;
  } catch {
    return 0;
  }
}

/** /healthz block: {enabled, backoff_until, last_ok, last_error {at, status, message}, cache_entries (ok results only)}. */
export function spellbookHealth(db, { env = process.env, now = Date.now() } = {}) {
  const s = spellbookSettings(db, env);
  const backoff = backoffUntil(db);
  const lastError = parseJson(getAppMeta(db, META_LAST_ERROR));
  let entries = 0;
  try { entries = db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache WHERE status = 'ok'").get().n; } catch { entries = 0; }
  return {
    enabled: s.enabled,
    env_disabled: s.env_disabled,
    backoff_until: backoff > now ? iso(backoff) : null,
    last_ok: getAppMeta(db, META_LAST_OK),
    last_error: lastError,
    cache_entries: entries,
  };
}

// ---------------------------------------------------------------------------
// Background scheduling (the server wires it; the MCP process may use
// refreshCombos directly or a scheduler of its own)

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Background filler. opts: ctx fields for refreshCombos (db, restoring,
 * fetch, env, version, now, log) plus requestFor(db, deckId) → request|null
 * (the caller decides isCommanderDeck), delayMs (debounce, 3000) and
 * maxWaits (slot retries per job, 40). Jobs run one at a time, one per key;
 * a job blocked by spacing/busy waits for its slot, one in backoff ends with
 * the cached/offline view (the next read starts it again).
 * Returns {schedule(deckId), ensure(request), refresh(request),
 * evaluate(request, {waitMs}), pending(), close()}.
 */
export function createSpellbookScheduler({ requestFor = null, delayMs = 3000, maxWaits = 40, ...ctx } = {}) {
  const timers = new Map(); // deckId -> timeout
  const jobs = new Map(); // key -> {request, force, promise, resolve}
  const queue = [];
  const stop = new AbortController();
  let running = false;

  async function runJob(job) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await refreshCombos(ctx, job.request, { force: job.force });
      } catch (err) { // refreshCombos never throws; belt and braces
        res = { status: "offline", fetched_at: null, result: null, reason: "error", error: err.message };
      }
      const wait = ["spacing", "busy", "restoring"].includes(res.reason);
      if (!wait || attempt >= maxWaits || stop.signal.aborted) return res;
      const clock = ctx.now ?? Date.now;
      await sleep(Math.max(50, (res.retry_at ?? clock() + SPACING_MS) - clock() + 25), stop.signal);
      if (stop.signal.aborted) return res;
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stop.signal.aborted) {
        const key = queue.shift();
        const job = jobs.get(key);
        if (!job) continue;
        const res = await runJob(job);
        jobs.delete(key);
        job.resolve(res);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(request, force) {
    if (!request) return Promise.resolve({ status: "disabled", fetched_at: null, result: null, reason: "not_commander" });
    if (stop.signal.aborted) return Promise.resolve({ status: "pending", fetched_at: null, result: null, reason: "closed" });
    const existing = jobs.get(request.key);
    if (existing) {
      if (force) existing.force = true;
      return existing.promise;
    }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    jobs.set(request.key, { request, force, promise, resolve });
    queue.push(request.key);
    pump();
    return promise;
  }

  return {
    /** Debounced (delayMs) refresh after a deck write. */
    schedule(deckId) {
      if (stop.signal.aborted) return;
      clearTimeout(timers.get(deckId));
      const t = setTimeout(() => {
        timers.delete(deckId);
        let request = null;
        try {
          const db = currentDb(ctx);
          if (!db || isRestoring(ctx) || !requestFor) return;
          request = requestFor(db, deckId);
        } catch (err) {
          ctx.log?.warn?.(`[spellbook] deck ${deckId}: ${err.message}`);
          return;
        }
        if (request) enqueue(request, false);
      }, delayMs);
      t.unref?.();
      timers.set(deckId, t);
    },
    /** Fetch when missing/stale (deduped per key); resolves with the result. */
    ensure: (request) => enqueue(request, false),
    /** Force a refetch (POST /api/decks/:id/combos). */
    refresh: (request) => enqueue(request, true),
    /**
     * Wait at most waitMs (8000) for a fetch, else the cached view
     * (pending/offline/stale) while the job goes on in the background.
     */
    async evaluate(request, { waitMs = 8000 } = {}) {
      const job = enqueue(request, false);
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(null), waitMs); timer.unref?.(); });
      const res = await Promise.race([job, timeout]);
      clearTimeout(timer);
      if (res) return res;
      const db = currentDb(ctx);
      return db ? cachedCombos(db, request.key, { env: ctx.env, touch: false }) : { status: "pending", fetched_at: null, result: null };
    },
    /** Keys queued or in flight. */
    pending: () => [...jobs.keys()],
    close() {
      stop.abort();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const job of jobs.values()) job.resolve({ status: "pending", fetched_at: null, result: null, reason: "closed" });
      jobs.clear();
      queue.length = 0;
    },
  };
}
