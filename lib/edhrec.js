// What other players run with a commander (plan v1.3.0 #075), from EDHREC's
// public page data (json.edhrec.com, built from tens of thousands of decks per
// popular commander; the user accepted unofficial sources with a large user
// base). Per card: inclusion = decks with the card / decks that could play it,
// and synergy = how much more often it appears with this commander than in
// other decks of its colours. Bracket pages narrow it to a power level.
// Cached 30 days per commander and bracket.

import { cachedJson, getJson } from "./webcache.js";

const BASE = process.env.EDHREC_URL || "https://json.edhrec.com/pages/commanders";
const TTL_MS = 30 * 24 * 3600 * 1000;
/** EDHREC page per Commander bracket (B1 exhibition … B5 cEDH). */
export const BRACKET_PAGES = Object.freeze({ 1: "exhibition", 2: "core", 3: "upgraded", 4: "optimized", 5: "cedh" });

/** EDHREC's slug of a commander name ("Atraxa, Praetors' Voice" → "atraxa-praetors-voice"; a DFC by its front face). */
export function edhrecSlug(name) {
  return String(name).split(" // ")[0].normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The commander's cards on EDHREC: {slug, bracket, decks (potential decks), cards: [{name, list, inclusion %,
 * synergy %, decks}]} sorted by inclusion, plus {fetched_at, stale?}. Throws (404 = unknown commander) only when
 * nothing is cached.
 */
export async function commanderStaples(db, commander, { bracket = null } = {}) {
  const slug = edhrecSlug(commander);
  const page = bracket && BRACKET_PAGES[bracket] ? `/${BRACKET_PAGES[bracket]}` : "";
  const r = await cachedJson(db, `edhrec:${slug}${page}`, TTL_MS, () => getJson(`${BASE}/${slug}${page}.json`).then(slim));
  return { slug, bracket: page ? Number(bracket) : null, ...r.data, fetched_at: r.fetched_at, ...(r.stale ? { stale: true, error: r.error } : {}) };
}

// Only what the planner reads (the full page is ~300 KB).
function slim(page) {
  const lists = page?.container?.json_dict?.cardlists ?? [];
  const seen = new Map();
  let decks = 0;
  for (const l of lists) {
    if (l.tag === "newcards") continue;
    for (const c of l.cardviews ?? []) {
      if (!c?.name || !c.potential_decks) continue;
      decks = Math.max(decks, c.potential_decks);
      if (seen.has(c.name)) continue;
      seen.set(c.name, { name: c.name, list: l.header, inclusion: Math.round((c.num_decks / c.potential_decks) * 100), synergy: Math.round((c.synergy ?? 0) * 100), decks: c.num_decks });
    }
  }
  return { decks, cards: [...seen.values()].sort((a, b) => b.inclusion - a.inclusion || b.synergy - a.synergy) };
}
