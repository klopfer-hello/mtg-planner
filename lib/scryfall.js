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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slots = { all: 0, limited: 0 };

async function throttle(slot, interval) {
  const now = Date.now();
  const wait = slots[slot] - now;
  slots[slot] = Math.max(now, slots[slot]) + interval;
  if (wait > 0) await sleep(wait);
}

export async function scryfall(pathname, { method = "GET", body, signal } = {}, attempt = 0) {
  if (LIMITED.test(pathname)) await throttle("limited", LIMITED_INTERVAL_MS);
  await throttle("all", MIN_INTERVAL_MS);
  const res = await fetch(API + pathname, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 429 && attempt < 3) {
    await sleep(1000 * (attempt + 1));
    return scryfall(pathname, { method, body, signal }, attempt + 1);
  }
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
 * `signal` (optional AbortSignal) bounds every request.
 */
export async function fetchCollection(identifiers, onProgress, { signal } = {}) {
  const cards = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += BATCH) {
    const chunk = identifiers.slice(i, i + BATCH);
    const data = await scryfall("/cards/collection", { method: "POST", body: { identifiers: chunk }, signal });
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
  };
}
