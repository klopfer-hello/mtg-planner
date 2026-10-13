// Minimal Scryfall client: polite rate limiting, batched lookups via
// /cards/collection, and normalisation into rows for the `cards` table.

const API = "https://api.scryfall.com";
const USER_AGENT = process.env.SCRYFALL_USER_AGENT || "mtg-planner/1.0 (+https://github.com/klopfer-hello/mtg-planner)";
const MIN_INTERVAL_MS = 120; // Scryfall asks for 50–100 ms between requests
const BATCH = 75; // /cards/collection maximum

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;

async function throttle() {
  const now = Date.now();
  const wait = nextSlot - now;
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

export async function scryfall(pathname, { method = "GET", body } = {}, attempt = 0) {
  await throttle();
  const res = await fetch(API + pathname, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 3) {
    await sleep(1000 * (attempt + 1));
    return scryfall(pathname, { method, body }, attempt + 1);
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
 */
export async function fetchCollection(identifiers, onProgress) {
  const cards = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += BATCH) {
    const chunk = identifiers.slice(i, i + BATCH);
    const data = await scryfall("/cards/collection", { method: "POST", body: { identifiers: chunk } });
    cards.push(...(data.data || []));
    notFound.push(...(data.not_found || []));
    onProgress?.(Math.min(i + BATCH, identifiers.length), identifiers.length);
  }
  return { cards, notFound };
}

const COLOR_ORDER = "WUBRG";
const sortColors = (arr) => [...new Set(arr || [])].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b)).join("");

export function normalizeCard(c) {
  const faces = c.card_faces || [];
  const images = c.image_uris || faces[0]?.image_uris || {};
  const joinFaces = (key) => (c[key] != null ? c[key] : faces.map((f) => f[key]).filter(Boolean).join(" // ") || null);
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
    cmc: c.cmc ?? 0,
    colors: sortColors(c.colors ?? faces.flatMap((f) => f.colors || [])),
    color_identity: sortColors(c.color_identity),
    oracle_text: c.oracle_text ?? (faces.map((f) => f.oracle_text).filter(Boolean).join("\n//\n") || null),
    keywords: JSON.stringify(c.keywords || []),
    legalities: JSON.stringify(c.legalities || {}),
    prices: JSON.stringify(c.prices || {}),
    image_small: images.small || null,
    image_normal: images.normal || null,
    scryfall_uri: c.scryfall_uri || null,
    fetched_at: new Date().toISOString(),
  };
}
