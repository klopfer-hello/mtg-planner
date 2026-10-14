// Language "as scanned" and the English-twin EUR price fallback (v0.5.0 beta.4):
// storagePrinting('scanned') keeps the detected printing, scans commit it in
// its own language, and every value (collection/binder stats, card prices,
// decks, the scan list) uses the English twin's EUR price when a foreign
// printing has none: lib/prices.js copies it into the card row (`*_en` keys)
// from one batched index call or the twin's cards row, upsertCards keeps the
// keys. Offline: a local bulk file for the index, no Scryfall.

import { after, before, beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { cardPrice, eurOf, stats, upsertCards } from "../lib/db.js";
import { openIndex, printingPricesEur, refreshIndex, storagePrinting, getPrinting, STORE_AS_SCANNED } from "../lib/cardindex.js";
import * as indexModule from "../lib/cardindex.js";
import { deckDetail, eurForFinish, eurOfPrinting, saveDeckRows } from "../lib/decks.js";
import { syncEnglishPrices } from "../lib/prices.js";
import { commitScans, priceScans, stageScan, updateScan, listScans } from "../lib/scans.js";
import { searchCollection } from "../lib/query.js";
import { tempDb } from "./fixtures.js";

const SETS = [{ code: "m15", name: "Magic 2015", set_type: "core", released_at: "2014-07-18", card_count: 284, printed_size: 269 }];
const card = (o) => ({
  object: "card", oracle_id: `o-${o.name}`, lang: "en", games: ["paper"], digital: false, released_at: "2014-07-18", rarity: "rare",
  finishes: ["nonfoil", "foil"], promo_types: [], illustration_id: `ill-${o.name}`, frame: "2015", border_color: "black", full_art: false,
  frame_effects: [], layout: "normal", image_status: "highres_scan", type_line: "Instant", mana_cost: "{R}", set: "m15", set_name: "Magic 2015", ...o,
});
const BOLT_EN = card({ id: "p-0001", name: "Lightning Bolt", collector_number: "155", prices: { eur: "1.50", eur_foil: "7.25", usd: "2.00" } });
const BOLT_IT = card({ id: "p-0002", name: "Lightning Bolt", collector_number: "155", lang: "it", printed_name: "Fulmine", prices: { eur: null, eur_foil: null, usd: null } });
const BOLT_DE = card({ id: "p-0003", name: "Lightning Bolt", collector_number: "155", lang: "de", printed_name: "Blitzschlag", prices: { eur: null, usd: null } });
const SHOCK_EN = card({ id: "p-0010", name: "Shock", collector_number: "156", prices: { eur: "0.20" } });
const SHOCK_JA = card({ id: "p-0011", name: "Shock", collector_number: "156", lang: "ja", printed_name: "ショック", prices: { eur: "0.90" } });

let dir, idx;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-enprices-"));
  const file = path.join(dir, "all.jsonl.gz");
  writeFileSync(file, gzipSync([BOLT_EN, BOLT_IT, BOLT_DE, SHOCK_EN, SHOCK_JA].map((c) => JSON.stringify(c)).join("\n")));
  idx = openIndex(path.join(dir, "cardindex.db"));
  await refreshIndex(idx, { source: file, setsSource: SETS });
});
after(() => { try { idx.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

// App cards rows (Scryfall shape after normalizeCard: prices JSON text).
const cardRow = (c, prices = c.prices) => ({
  scryfall_id: c.id, oracle_id: c.oracle_id, name: c.name, set_code: c.set, set_name: c.set_name, collector_number: c.collector_number,
  lang: c.lang, rarity: c.rarity, type_line: c.type_line, mana_cost: c.mana_cost, cmc: 1, colors: "R", color_identity: "R",
  oracle_text: "", keywords: "[]", legalities: "{}", prices: JSON.stringify(prices ?? {}), image_small: null, image_normal: null,
  scryfall_uri: null, fetched_at: "2026-10-14",
});
const own = (db, id, qty, { finish = "normal", language = "en", binder = "" } = {}) => db.prepare(
  "INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, ?, ?, 'near_mint', ?, ?, 'scan')",
).run(id, finish, language, binder, qty);
const pricesOf = (db, id) => JSON.parse(db.prepare("SELECT prices FROM cards WHERE scryfall_id = ?").get(id).prices);
const indexPrices = async (items) => printingPricesEur(idx, items);

let ctx;
beforeEach(() => { ctx = tempDb(); });
afterEach(() => ctx.cleanup());

describe("price readers", () => {
  test("eurOf / cardPrice: own EUR first, then the English twin's, before any USD; never USD for eurOf", () => {
    const p = { eur: null, eur_foil: null, usd: "9.00", eur_en: 1.5, eur_foil_en: 7.25, id_en: "p-0001" };
    assert.equal(eurOf(p, "eur"), 1.5);
    assert.equal(eurOf(p, "eur_foil"), 7.25);
    assert.equal(eurOf({ usd: "3" }, "eur"), null);
    assert.equal(eurOf({ eur: "2.00", eur_en: 1.5 }, "eur"), 2);
    assert.deepEqual(cardPrice({ prices: p }), { value: 1.5, currency: "€", en: true });
    assert.deepEqual(cardPrice({ prices: JSON.stringify(p) }, "foil"), { value: 7.25, currency: "€", en: true });
    assert.deepEqual(cardPrice({ prices: { eur: "2.00", eur_en: 1.5 } }), { value: 2, currency: "€" });
    assert.deepEqual(cardPrice({ prices: { usd: "3" } }), { value: 3, currency: "$" });
    // foil-only twin: no plain price anywhere, the foil one is used
    assert.deepEqual(cardPrice({ prices: { eur_foil_en: 4 } }), { value: 4, currency: "€", en: true });
    assert.equal(cardPrice({ prices: "not json" }), null);
    assert.equal(eurForFinish({ eur_en: 1.5 }, "normal"), 1.5);
    assert.equal(eurForFinish({ eur_en: 1.5 }, "foil"), null, "exact finish only");
    assert.equal(eurOfPrinting(JSON.stringify({ eur_foil_en: 7.25 })), 7.25);
  });

  test("upsertCards keeps the *_en keys on a re-fetch unless the new prices carry them", () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT)]);
    db.prepare("UPDATE cards SET prices = ? WHERE scryfall_id = ?").run(JSON.stringify({ eur: null, eur_en: 1.5, id_en: "p-0001" }), BOLT_IT.id);
    upsertCards(db, [cardRow(BOLT_IT, { eur: null, usd: "0.5" })]);
    // (json_patch merge: null prices are dropped, which every reader treats like a missing key)
    assert.deepEqual(pricesOf(db, BOLT_IT.id), { eur_en: 1.5, id_en: "p-0001", usd: "0.5" });
    upsertCards(db, [cardRow(BOLT_IT, { eur: "3.00", eur_en: 2 })]);
    assert.deepEqual(pricesOf(db, BOLT_IT.id), { id_en: "p-0001", eur: "3.00", eur_en: 2 });
    // rows without *_en keys are stored exactly as given
    upsertCards(db, [cardRow(BOLT_EN)]);
    upsertCards(db, [cardRow(BOLT_EN, { eur: "1.60", eur_foil: "7.00" })]);
    assert.equal(db.prepare("SELECT prices FROM cards WHERE scryfall_id = ?").get(BOLT_EN.id).prices, JSON.stringify({ eur: "1.60", eur_foil: "7.00" }));
  });
});

describe("syncEnglishPrices", () => {
  test("index twin prices land in the foreign rows; own prices and English rows untouched; idempotent", async () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT), cardRow(SHOCK_JA), cardRow(SHOCK_EN)]);
    const r = await syncEnglishPrices(db, { indexPrices });
    assert.deepEqual(r, { checked: 2, updated: 2, index: true });
    assert.deepEqual(pricesOf(db, BOLT_IT.id), { eur: null, eur_foil: null, usd: null, eur_en: 1.5, eur_foil_en: 7.25, id_en: "p-0001" });
    assert.equal(pricesOf(db, SHOCK_JA.id).eur, "0.90");
    assert.equal(pricesOf(db, SHOCK_JA.id).eur_en, 0.2);
    assert.deepEqual(pricesOf(db, SHOCK_EN.id), { eur: "0.20" });
    assert.equal((await syncEnglishPrices(db, { indexPrices })).updated, 0);
  });

  test("without the index: the twin's cards row; a failing index never removes keys", async () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_DE), cardRow(BOLT_EN, { eur: "1.80" })]);
    let r = await syncEnglishPrices(db);
    assert.deepEqual(r, { checked: 1, updated: 1, index: false });
    assert.deepEqual(pricesOf(db, BOLT_DE.id), { eur: null, usd: null, eur_en: 1.8, id_en: "p-0001" });
    db.prepare("DELETE FROM cards WHERE scryfall_id = ?").run(BOLT_EN.id);
    r = await syncEnglishPrices(db, { indexPrices: async () => { throw new Error("worker down"); } });
    assert.equal(r.updated, 0);
    assert.equal(pricesOf(db, BOLT_DE.id).eur_en, 1.8, "kept");
    // a working index replaces them (the index twin has eur 1.50, no foil)
    r = await syncEnglishPrices(db, { indexPrices });
    assert.equal(r.updated, 1);
    assert.deepEqual(pricesOf(db, BOLT_DE.id), { eur: null, usd: null, eur_en: 1.5, id_en: "p-0001", eur_foil_en: 7.25 });
  });

  test("a twin without prices removes stale keys once the index answered", async () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT, { eur: null, eur_en: 9, id_en: "x" })]);
    db.prepare("UPDATE cards SET collector_number = '999' WHERE scryfall_id = ?").run(BOLT_IT.id);
    const r = await syncEnglishPrices(db, { indexPrices: async (items) => items.map((i) => ({ id: i.id, finish: i.finish, eur: null, en_id: null, en_eur: null })) });
    assert.equal(r.updated, 1);
    assert.deepEqual(pricesOf(db, BOLT_IT.id), { eur: null });
  });

  test("prices written while the index call is pending survive (only the English keys are applied)", async () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT, { eur: "1.00", usd: "1.10" })]);
    const r = await syncEnglishPrices(db, {
      indexPrices: async (items) => {
        // A price refresh / import re-fetches the row meanwhile.
        upsertCards(db, [cardRow(BOLT_IT, { eur: "5.00", usd: "6.00" })]);
        return printingPricesEur(idx, items);
      },
    });
    assert.equal(r.updated, 1);
    assert.deepEqual(pricesOf(db, BOLT_IT.id), { eur: "5.00", usd: "6.00", eur_en: 1.5, eur_foil_en: 7.25, id_en: "p-0001" });
  });
});

describe("values use the English twin", () => {
  async function foreignCollection() {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT), cardRow(BOLT_EN)]);
    own(db, BOLT_IT.id, 2, { language: "it", binder: "Italian" });
    own(db, BOLT_IT.id, 1, { language: "it", finish: "foil", binder: "Italian" });
    own(db, BOLT_EN.id, 1, { binder: "Main" });
    await syncEnglishPrices(db, { indexPrices });
    return db;
  }

  test("collection and binder stats, collection rows (cardPrice)", async () => {
    const db = await foreignCollection();
    // 2 x 1.50 + 1 x 7.25 (foil twin) + 1 x 1.50 (own English)
    assert.equal(stats(db).value_eur, 11.75);
    assert.equal(stats(db, { binder: "italian" }).value_eur, 10.25);
    const { rows } = searchCollection(db, { q: "", group: "printing", binder: "Italian" });
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.equal(cardPrice(r, r.finish).currency, "€");
  });

  test("deck value: owned foreign copies at the twin's finish price, a foreign deck printing to buy at its twin's", async () => {
    const db = await foreignCollection();
    const id = saveDeckRows(db, { name: "Burn", rows: [{ board: "main", name: "Lightning Bolt", scryfall_id: BOLT_IT.id, quantity: 6 }] });
    const d = deckDetail(db, id);
    // owned 4 (it 2 normal 1.50, it foil 7.25, en 1.50 in row order) + 2 to buy at 1.50
    assert.equal(d.value.owned_eur, 11.75);
    assert.equal(d.value.to_buy_eur, 3);
    assert.equal(d.value.no_eur_price, 0);
    assert.equal(d.shopping.items[0].price_eur, 1.5);
  });

  test("scan list value reads the twin keys of a cards row when the index has no price", async () => {
    const db = ctx.db;
    upsertCards(db, [cardRow(BOLT_IT, { eur: null, eur_en: 1.5 })]);
    const rows = [{ store_printing_id: BOLT_IT.id, finish: "normal", quantity: 2, match_status: "auto" }];
    const totals = await priceScans(db, rows);
    assert.equal(rows[0].price_eur, 1.5);
    assert.equal(totals.value_eur, 3);
  });
});

describe("storage language 'scanned'", () => {
  test("storagePrinting keeps the detected printing; other languages unchanged", () => {
    const it = getPrinting(idx, BOLT_IT.id);
    assert.equal(STORE_AS_SCANNED, "scanned");
    assert.equal(storagePrinting(idx, it, "scanned").id, BOLT_IT.id);
    assert.equal(storagePrinting(idx, it, "en").id, BOLT_EN.id);
    assert.equal(storagePrinting(idx, it, "de").id, BOLT_DE.id);
  });

  const result = (printing, storageLang) => ({
    status: "auto", printing, store: storagePrinting(idx, printing, storageLang) || printing, finish: "normal", finishSource: "finishes",
    method: "ocr", confidence: 0.95, candidates: [], variants: [], features: { settings: { storageLang, foil: "auto" } }, timings: {},
  });

  test("a scan staged as scanned commits the detected printing in its language; 'en' keeps today's behaviour", async () => {
    const db = ctx.db;
    const imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-enprices-img-"));
    try {
      const it = getPrinting(idx, BOLT_IT.id);
      const a = stageScan(db, result(it, "scanned"), { imageDir }).scan;
      assert.equal(a.store_printing_id, BOLT_IT.id);
      assert.equal(a.store_lang, "it");
      const de = getPrinting(idx, BOLT_DE.id);
      const b = stageScan(db, result(de, "en"), { imageDir, force: true }).scan;
      assert.equal(b.store_printing_id, BOLT_EN.id);
      const offline = async () => ({ cards: [] }); // Scryfall unreachable: cards rows from the index
      await commitScans(db, [a.id, b.id], { type: "binder", name: "Box", create: true }, { idx, imageDir, fetchCards: offline });
      const rows = db.prepare("SELECT scryfall_id, language, quantity FROM collection ORDER BY scryfall_id").all().map((r) => ({ ...r }));
      assert.deepEqual(rows, [{ scryfall_id: BOLT_EN.id, language: "en", quantity: 1 }, { scryfall_id: BOLT_IT.id, language: "it", quantity: 1 }]);
      // Offline rows carry the index prices (the English one) and, after the sync, the twin's for the Italian one.
      assert.equal(pricesOf(db, BOLT_EN.id).eur, "1.5");
      await syncEnglishPrices(db, { indexPrices });
      assert.equal(stats(db).value_eur, 3);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  test("updateScan on a scan staged as scanned stores the picked printing itself", () => {
    const db = ctx.db;
    const imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-enprices-img-"));
    try {
      const s = stageScan(db, result(getPrinting(idx, BOLT_IT.id), "scanned"), { imageDir }).scan;
      let u = updateScan(db, s.id, { printing_id: BOLT_DE.id }, { idx, index: indexModule });
      assert.equal(u.store_printing_id, BOLT_DE.id);
      assert.equal(u.store_lang, "de");
      u = updateScan(db, s.id, { store_lang: "en" }, { idx, index: indexModule });
      assert.equal(u.store_printing_id, BOLT_EN.id);
      u = updateScan(db, s.id, { store_lang: "scanned" }, { idx, index: indexModule });
      assert.equal(u.store_printing_id, BOLT_DE.id);
      assert.throws(() => updateScan(db, s.id, { store_lang: "klingon" }, { idx, index: indexModule }), /language code/);
      assert.equal(listScans(db).length, 1);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });
});
