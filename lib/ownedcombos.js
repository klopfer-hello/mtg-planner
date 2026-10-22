// Combos the collection already holds (plan v1.3.0 #073): Commander
// Spellbook's find-my-combos with the user's owned (by default free) cards in a
// colour identity, so the planner can build around real combos instead of
// finding them by luck, and knows which single buy completes one.
// Uses the Spellbook settings of lib/spellbook.js (off = off); cached 7 days
// per card set.

import { createHash } from "node:crypto";
import { idTerm, isBasicLand } from "./deckrules.js";
import { searchCollection } from "./query.js";
import { spellbookSettings } from "./spellbook.js";
import { cachedJson, getJson } from "./webcache.js";

const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_NAMES = 2000;
const BRACKET_OF_TAG = { R: 1, S: 1, P: 2, O: 3, C: 3, E: 4, B: 4 }; // Spellbook bracket tags, roughly (lib/spellbook.js tagToBracket for decks)

/** Owned cards (front names) within `identity` ("WB"; "" = colourless; null = any), free copies only by default (search avail>=1). */
export function ownedNames(db, { identity = null, freeOnly = true } = {}) {
  const terms = [freeOnly ? "avail>=1" : "", identity == null ? "" : idTerm(identity)];
  const names = new Set();
  for (let offset = 0; ; offset += 500) { // searchCollection pages at 500 rows
    const { rows } = searchCollection(db, { q: terms.filter(Boolean).join(" "), limit: 500, offset });
    for (const r of rows) if (!isBasicLand(r.name)) names.add(r.name.split(" // ")[0]);
    if (rows.length < 500) break;
  }
  return [...names].sort();
}

const comboOf = (c) => ({
  id: String(c.id), cards: (c.uses || []).map((u) => u.card?.name).filter(Boolean),
  produces: (c.produces || []).map((p) => p.feature?.name).filter(Boolean).slice(0, 3),
  bracket: BRACKET_OF_TAG[c.bracketTag] ?? null, mana_value: c.manaValueNeeded ?? null, popularity: c.popularity ?? 0,
});

/**
 * Spellbook combos among the given card names (+ commanders): {complete: [...], one_missing: [{..., missing}],
 * names, truncated, fetched_at, stale?}. Throws when Spellbook is off or unreachable with nothing cached.
 */
export async function findCombos(db, names, { commanders = [] } = {}) {
  const s = spellbookSettings(db);
  if (!s.enabled) throw new Error("the Commander Spellbook check is turned off in Settings");
  const list = [...new Set(names)].slice(0, MAX_NAMES);
  const key = `combos:${createHash("sha1").update(JSON.stringify([list, commanders])).digest("base64url")}`;
  const url = String(s.url).replace(/estimate-bracket\/?$/, "find-my-combos");
  const r = await cachedJson(db, key, TTL_MS, async () => {
    const res = (await getJson(url, { method: "POST", body: { main: list.map((card) => ({ card })), commanders: commanders.map((card) => ({ card })) }, timeoutMs: s.timeout_ms || 20000 })).results ?? {};
    const have = new Set([...list, ...commanders].map((n) => n.toLowerCase()));
    return {
      complete: (res.included ?? []).map(comboOf),
      one_missing: (res.almostIncluded ?? []).map(comboOf).map((c) => ({ ...c, missing: c.cards.filter((n) => !have.has(n.toLowerCase())) })),
    };
  });
  const byPop = (a, b) => b.popularity - a.popularity;
  return { complete: [...r.data.complete].sort(byPop), one_missing: [...r.data.one_missing].sort(byPop), names: list.length, truncated: names.length > MAX_NAMES, fetched_at: r.fetched_at, ...(r.stale ? { stale: true, error: r.error } : {}) };
}
