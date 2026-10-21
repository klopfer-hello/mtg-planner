// Minimal Scryfall client: polite rate limiting, batched lookups via
// /cards/collection, and normalisation into rows for the `cards` table.

const API = "https://api.scryfall.com";
const USER_AGENT = process.env.SCRYFALL_USER_AGENT || "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)";
const MIN_INTERVAL_MS = 120; // Scryfall asks for 50–100 ms between requests
const BATCH = 75; // /cards/collection maximum

// /cards/search, /cards/named and /cards/collection allow only 2 req/s (a 429
// locks the client out for 30 s), whoever calls them.
export const LIMITED_INTERVAL_MS = 500;
const LIMITED = /^\/cards\/(search|named|collection)\b/;

// Retries: a 429 waits out the lockout (Retry-After, else 30 s); a 5xx or a network error
// is retried after 2 s and 6 s. Two retries at most, then the error goes to the caller.
const RETRIES = 2;
const LOCKOUT_MS = 30_000;
const RETRY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slots = { all: 0, limited: 0 };
const intervals = { all: MIN_INTERVAL_MS, limited: LIMITED_INTERVAL_MS, retry: RETRY_MS, lockout: LOCKOUT_MS };

/** Tests only (test/fixtures.js stubScryfall): change the spacing and retry waits; no argument = the real ones. */
export function setThrottle({ minMs = MIN_INTERVAL_MS, limitedMs = LIMITED_INTERVAL_MS, retryMs = RETRY_MS, lockoutMs = LOCKOUT_MS } = {}) {
  intervals.all = minMs;
  intervals.limited = limitedMs;
  intervals.retry = retryMs;
  intervals.lockout = lockoutMs;
}

async function throttle(slot) {
  const interval = intervals[slot];
  const now = Date.now();
  const wait = slots[slot] - now;
  slots[slot] = Math.max(now, slots[slot]) + interval;
  if (wait > 0) await sleep(wait);
}

export async function scryfall(pathname, { method = "GET", body, signal } = {}, attempt = 0) {
  if (LIMITED.test(pathname)) await throttle("limited");
  await throttle("all");
  const again = async (ms) => { await sleep(ms); return scryfall(pathname, { method, body, signal }, attempt + 1); };
  let res;
  try {
    res = await fetch(API + pathname, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // Network errors are TypeErrors; an abort or timeout of `signal` is not retried.
    if (err instanceof TypeError && attempt < RETRIES && !signal?.aborted) return again(intervals.retry * (attempt * 2 + 1));
    throw err;
  }
  if (res.status === 429 && attempt < RETRIES) {
    const after = Number(res.headers.get("retry-after"));
    return again(after > 0 ? Math.min(after * 1000, intervals.lockout * 2) : intervals.lockout);
  }
  if (res.status >= 500 && attempt < RETRIES) return again(intervals.retry * (attempt * 2 + 1));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.details || `Scryfall ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Resolve Scryfall identifiers ({id} | {set, collector_number} | {name, set?})
 * in batches. Returns { cards: ScryfallCard[], notFound: identifier[] }.
 * `signal` (optional AbortSignal) bounds every request. `onChunk(cards)` (optional) gets each batch's
 * cards as it arrives, so a caller can keep what was fetched when a later batch fails.
 */
export async function fetchCollection(identifiers, onProgress, { signal, onChunk } = {}) {
  const cards = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += BATCH) {
    const chunk = identifiers.slice(i, i + BATCH);
    const data = await scryfall("/cards/collection", { method: "POST", body: { identifiers: chunk }, signal });
    await onChunk?.(data.data || []);
    cards.push(...(data.data || []));
    notFound.push(...(data.not_found || []));
    onProgress?.(Math.min(i + BATCH, identifiers.length), identifiers.length);
  }
  return { cards, notFound };
}

const COLOR_ORDER = "WUBRG";
const sortColors = (arr) => [...new Set(arr || [])].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b)).join("");

// Fields a reversible_card printing only carries on its faces (both faces are
// the same card; Scryfall gives it no top-level cmc, type, cost, colours or text).
const FRONT_FACE_LAYOUTS = new Set(["reversible_card"]);

/** produced_mana as a JSON array (top level, else the union over the faces), or null. */
function producedMana(c, faces) {
  const list = c.produced_mana ?? (faces.some((f) => f.produced_mana) ? [...new Set(faces.flatMap((f) => f.produced_mana || []))] : null);
  return list ? JSON.stringify(list) : null;
}

/**
 * Compact all_parts for the cards table (lib/accessories.js): the related token
 * printings and helper cards ({id, component, name, type_line}: tokens, emblems,
 * dungeons, The Monarch / Day // Night style cards), never the card itself or
 * other real cards (meld halves, combo pieces). [] when there are none.
 */
export function trimParts(card) {
  if (!Array.isArray(card?.all_parts)) return [];
  return card.all_parts
    .filter((p) => p && p.id && p.id !== card.id && p.name !== card.name)
    .filter((p) => p.component === "token" || (p.component === "combo_piece" && /^(Card|Dungeon|Emblem)\b|\bToken\b/.test(p.type_line ?? "")))
    .map((p) => ({ id: p.id, component: p.component, name: p.name, type_line: p.type_line ?? null }));
}

/**
 * A Scryfall card object as a `cards` row. cmc is NULL (unknown, never 0) when
 * neither the card nor its front face has one; game_changer is NULL when
 * Scryfall sent no flag (0/1 otherwise).
 */
export function normalizeCard(c) {
  const faces = c.card_faces || [];
  const images = c.image_uris || faces[0]?.image_uris || {};
  const front = FRONT_FACE_LAYOUTS.has(c.layout) ? faces[0] ?? {} : null;
  const joinFaces = (key) => (c[key] != null ? c[key] : front ? front[key] ?? null
    : faces.map((f) => f[key]).filter(Boolean).join(" // ") || null);
  return {
    scryfall_id: c.id,
    oracle_id: c.oracle_id || faces[0]?.oracle_id || c.id,
    name: c.name,
    set_code: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    lang: c.lang,
    rarity: c.rarity,
    type_line: joinFaces("type_line"),
    mana_cost: joinFaces("mana_cost"),
    cmc: c.cmc ?? faces[0]?.cmc ?? null,
    colors: sortColors(c.colors ?? (front ? front.colors : faces.flatMap((f) => f.colors || []))),
    color_identity: sortColors(c.color_identity),
    oracle_text: c.oracle_text ?? (front ? front.oracle_text ?? null : faces.map((f) => f.oracle_text).filter(Boolean).join("\n//\n") || null),
    keywords: JSON.stringify(c.keywords || []),
    legalities: JSON.stringify(c.legalities || {}),
    prices: JSON.stringify(c.prices || {}),
    image_small: images.small || null,
    image_normal: images.normal || null,
    scryfall_uri: c.scryfall_uri || null,
    fetched_at: new Date().toISOString(),
    game_changer: c.game_changer == null ? null : c.game_changer ? 1 : 0,
    produced_mana: producedMana(c, faces),
    layout: c.layout ?? null,
    // v15: tokens & extras (lib/accessories.js). '[]' = none; P/T of the card or its front face.
    all_parts: JSON.stringify(trimParts(c)),
    power: c.power ?? (faces[0]?.power ?? null),
    toughness: c.toughness ?? (faces[0]?.toughness ?? null),
  };
}
