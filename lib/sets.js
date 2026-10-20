// Set completion (Binders → Sets): which cards of a set you own, in any printing or language of that
// set, and what the rest would cost. The owned side comes from the app DB (collection ⋈ cards); the
// set's card list and prices come from the local card index (lib/cardindex.js setCompletion /
// setChecklist, called through the matcher worker by the server: whole-set scans never run on the
// main thread). A card owned only from ANOTHER set is still missing here, but the checklist says so.

/** Set types hidden from the list unless asked for: not something people complete. */
export const HIDDEN_SET_TYPES = new Set(["token", "memorabilia", "minigame", "vanguard", "treasure_chest"]);

/** {set_code: [oracle_id]} of every owned copy (set codes lower-case). */
export function ownedOracleBySet(db) {
  const out = {};
  for (const r of db.prepare(
    `SELECT DISTINCT lower(c.set_code) AS code, c.oracle_id FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
      WHERE c.oracle_id IS NOT NULL AND c.set_code IS NOT NULL`,
  ).all()) (out[r.code] ??= []).push(r.oracle_id);
  return out;
}

/**
 * Sets with at least one owned card: [{code, name, set_type, released_at, cards, owned, missing, pct,
 * missing_eur, unpriced, copies}], newest first. indexCall(fn, ...args) → Promise (the worker).
 * all = also the HIDDEN_SET_TYPES. Returns {sets, hidden} (hidden = how many sets were left out).
 */
export async function listSets(db, indexCall, { all = false } = {}) {
  const owned = ownedOracleBySet(db);
  const copies = new Map(db.prepare(
    "SELECT lower(c.set_code) AS code, SUM(col.quantity) AS n FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id GROUP BY lower(c.set_code)",
  ).all().map((r) => [r.code, r.n]));
  const rows = await indexCall("setCompletion", owned);
  let hidden = 0;
  const sets = [];
  for (const s of rows) {
    if (!all && HIDDEN_SET_TYPES.has(s.set_type)) { hidden++; continue; }
    sets.push({ ...s, pct: s.cards ? Math.round((1000 * s.owned) / s.cards) / 10 : 0, copies: copies.get(s.code) ?? 0 });
  }
  sets.sort((a, b) => String(b.released_at || "").localeCompare(String(a.released_at || "")) || a.name.localeCompare(b.name));
  return { sets, hidden };
}

/**
 * One set's checklist with ownership: {set, cards: [{…checklist card, owned (copies in this set), langs,
 * finishes, owned_id (an owned printing, for the card sheet), elsewhere (copies from other sets)}],
 * totals {cards, owned, missing, missing_eur, unpriced, pct}} or null for an unknown set.
 */
export async function setDetail(db, indexCall, code) {
  const list = await indexCall("setChecklist", String(code).toLowerCase());
  if (!list) return null;
  const here = new Map();
  for (const r of db.prepare(
    `SELECT c.oracle_id, col.quantity, col.language, col.finish, col.scryfall_id
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id WHERE lower(c.set_code) = ?`,
  ).all(list.set.code)) {
    const e = here.get(r.oracle_id) ?? { owned: 0, langs: new Set(), finishes: new Set(), owned_id: r.scryfall_id };
    e.owned += r.quantity;
    e.langs.add(r.language);
    e.finishes.add(r.finish);
    here.set(r.oracle_id, e);
  }
  const anywhere = new Map(db.prepare(
    "SELECT c.oracle_id, SUM(col.quantity) AS n FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id GROUP BY c.oracle_id",
  ).all().map((r) => [r.oracle_id, r.n]));
  let owned = 0, missingEur = 0, unpriced = 0;
  const cards = list.cards.map((c) => {
    const h = here.get(c.oracle_id);
    if (h) owned++;
    else if (c.eur == null) unpriced++;
    else missingEur += c.eur;
    return {
      ...c, owned: h?.owned ?? 0, langs: h ? [...h.langs].sort() : [], finishes: h ? [...h.finishes].sort() : [], owned_id: h?.owned_id ?? null,
      elsewhere: (anywhere.get(c.oracle_id) ?? 0) - (h?.owned ?? 0),
    };
  });
  const n = cards.length;
  return {
    set: list.set, cards,
    totals: { cards: n, owned, missing: n - owned, missing_eur: Math.round(missingEur * 100) / 100, unpriced, pct: n ? Math.round((1000 * owned) / n) / 10 : 0 },
  };
}
