// English-twin EUR prices for foreign printings.
//
// Scryfall (Cardmarket trend) rarely prices non-English printings, so an
// Italian or German copy stored "as scanned" would count €0 in every value.
// The fallback is the English twin: same set + collector number, lang en.
// Values are computed synchronously all over the app (collection stats,
// binder value, decks, the MCP server in its own process), so the twin's
// prices are not looked up there: they are copied into the foreign card row's
// `prices` JSON as `eur_en`, `eur_foil_en`, `eur_etched_en` (+ `id_en`), and
// the price readers (db.js eurOf / cardPrice) fall back to them. This module
// keeps those keys current: one batched index call (printingPricesEur in the
// matcher worker, never per-row lookups on the main thread), else the twin's
// row in the app's own `cards` table. upsertCards keeps the keys when a card
// row is re-fetched, so a price refresh never drops them.

import { EN_PRICE_SUFFIX, parsePrices, transaction } from "./db.js";

const KEYS = ["eur", "eur_foil", "eur_etched"];
const FINISH_OF_KEY = { eur: "normal", eur_foil: "foil", eur_etched: "etched" };
const ID_KEY = "id" + EN_PRICE_SUFFIX;
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Apply set/delete of English keys to `prices` in place; true when it changed. */
function applyEn(prices, set, del) {
  let changed = false;
  for (const [k, v] of Object.entries(set)) {
    if (prices[k] !== v) { prices[k] = v; changed = true; }
  }
  for (const k of del) {
    if (k in prices) { delete prices[k]; changed = true; }
  }
  return changed;
}

/**
 * Refresh the English-twin price keys of every foreign printing in `cards`.
 * `indexPrices(items)` = cardindex printingPricesEur(idx, items) (async, e.g.
 * through the matcher worker; optional). Per key the index twin's price wins,
 * else the twin's own price in `cards`. When the index call fails (or there is
 * none) existing keys are only added to or overwritten, never removed.
 * Writes only changed rows, in one transaction. Returns {checked, updated, index}.
 */
export async function syncEnglishPrices(db, { indexPrices = null } = {}) {
  const rows = db.prepare(
    "SELECT scryfall_id, set_code, collector_number, prices FROM cards WHERE lang IS NOT NULL AND lang <> 'en'",
  ).all();
  if (!rows.length) return { checked: 0, updated: 0, index: false };

  // Index twins: three items per card (one per finish); printingPricesEur
  // looks each id up once.
  let fromIndex = null;
  if (indexPrices) {
    const items = rows.flatMap((r) => KEYS.map((k) => ({ id: r.scryfall_id, finish: FINISH_OF_KEY[k] })));
    try {
      const out = await indexPrices(items);
      if (Array.isArray(out) && out.length === items.length) fromIndex = out;
    } catch (err) {
      console.warn(`[prices] English twin lookup failed: ${err.message}`);
    }
  }

  // Twins in the app's cards table (by set + collector number), one query.
  const enRows = db.prepare(
    `SELECT scryfall_id, set_code, collector_number, prices FROM cards
      WHERE lang = 'en' AND set_code IN (SELECT DISTINCT set_code FROM cards WHERE lang IS NOT NULL AND lang <> 'en')`,
  ).all();
  const enByKey = new Map(enRows.map((r) => [`${r.set_code}|${r.collector_number}`, r]));

  // Per row only the delta of the English keys ({set, del}); it is applied to
  // the row's current prices inside the transaction, because the await above
  // lets an import, price refresh or commit rewrite `prices` meanwhile.
  const changes = [];
  rows.forEach((r, i) => {
    const prices = parsePrices(r.prices);
    const twin = enByKey.get(`${r.set_code}|${r.collector_number}`) ?? null;
    const twinPrices = twin ? parsePrices(twin.prices) : {};
    const set = {};
    const del = [];
    let enId = null;
    KEYS.forEach((k, j) => {
      const x = fromIndex ? fromIndex[i * KEYS.length + j] : null;
      const idxEur = x && x.id === r.scryfall_id ? num(x.en_eur) : null;
      if (x?.en_id) enId = x.en_id;
      const v = idxEur ?? num(twinPrices[k]);
      if (v != null) set[k + EN_PRICE_SUFFIX] = v;
      else if (fromIndex) del.push(k + EN_PRICE_SUFFIX);
    });
    enId ??= twin?.scryfall_id ?? null;
    const anyEn = KEYS.some((k) => set[k + EN_PRICE_SUFFIX] != null
      || (!del.includes(k + EN_PRICE_SUFFIX) && prices[k + EN_PRICE_SUFFIX] != null));
    if (anyEn && enId) set[ID_KEY] = enId;
    else if (!anyEn && fromIndex) del.push(ID_KEY);
    if (applyEn(prices, set, del)) changes.push({ id: r.scryfall_id, set, del });
  });
  let updated = 0;
  if (changes.length) {
    transaction(db, () => {
      const get = db.prepare("SELECT prices FROM cards WHERE scryfall_id = ?");
      const upd = db.prepare("UPDATE cards SET prices = ? WHERE scryfall_id = ?");
      for (const { id, set, del } of changes) {
        const cur = get.get(id);
        if (!cur) continue;
        const now = parsePrices(cur.prices);
        if (applyEn(now, set, del)) {
          upd.run(JSON.stringify(now), id);
          updated++;
        }
      }
    });
  }
  return { checked: rows.length, updated, index: Boolean(fromIndex) };
}
