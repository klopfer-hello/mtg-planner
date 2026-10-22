// Cards newer than the model's knowledge (plan v1.3.0 #072): a Scryfall search
// over recent sets (no reprints), filtered by colour identity, format and the
// app's role tags, with the user's copies marked. The cards are cached in the
// cards table (so get_cards reads them locally later) and the search for a day.

import { nowIso, upsertCards } from "./db.js";
import { classifyCard } from "./cardclass.js";
import { roleTags } from "./cardtags.js";
import { idTerm } from "./deckrules.js";
import { normalizeCard, scryfall } from "./scryfall.js";
import { cachedJson } from "./webcache.js";

const TTL_MS = 24 * 3600 * 1000;
const MAX_PAGES = 3; // 175 cards a page

/** YYYY-MM-DD `days` before today. */
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

/**
 * New cards: {query, since, cards: [row + {roles, owned}], total} newest first. identity "WB" = within it,
 * format = legal in it (commander, pauper, ...), role = role: value (lib/cardtags.js), extra = more Scryfall
 * syntax (e.g. "t:creature"). since defaults to one year ago.
 */
export async function recentCards(db, { identity = null, format = null, role = null, since = null, extra = "", ownedOnly = false } = {}) {
  const tags = role ? roleTags(role) : null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(since)) ? since : daysAgo(365);
  const q = [`date>=${from}`, "game:paper", "-is:reprint", "-t:basic",
    identity != null ? idTerm(identity) : "",
    format ? `f:${String(format).toLowerCase().replace(/[^a-z]/g, "")}` : "", String(extra || "").slice(0, 200)].filter(Boolean).join(" ");
  const r = await cachedJson(db, `recent:${q}`, TTL_MS, async () => {
    const ids = [];
    let path = `/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc&unique=cards`;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      let data;
      try { data = await scryfall(path); } catch (err) { if (err.status === 404) break; throw err; }
      const cards = (data.data || []).map(normalizeCard);
      upsertCards(db, cards);
      ids.push(...cards.map((c) => c.scryfall_id));
      path = data.has_more && data.next_page ? data.next_page.replace(/^https:\/\/api\.scryfall\.com/, "") : null;
    }
    return { ids, at: nowIso() };
  });
  const get = db.prepare("SELECT c.*, (SELECT COALESCE(SUM(col.quantity), 0) FROM collection col JOIN cards o ON o.scryfall_id = col.scryfall_id WHERE o.oracle_id = c.oracle_id) AS owned FROM cards c WHERE c.scryfall_id = ?");
  let cards = r.data.ids.map((id) => get.get(id)).filter(Boolean).map((c) => ({ ...c, roles: classifyCard(c).map((t) => t.tag) }));
  if (tags) cards = cards.filter((c) => c.roles.some((t) => tags.includes(t)));
  if (ownedOnly) cards = cards.filter((c) => c.owned > 0);
  return { query: q, since: from, cards, total: cards.length, fetched_at: r.fetched_at, ...(r.stale ? { stale: true, error: r.error } : {}) };
}
