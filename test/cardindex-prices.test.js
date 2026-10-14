// EUR prices in the card index (v0.5.0 scan sounds): refreshIndex fills
// eur/eur_foil/eur_etched from the bulk `prices`, openIndex adds the columns
// to an older index (idempotent), and scanPriceEur picks the stored printing
// + finish price with the app `cards` table and the English twin as fallbacks.
// Offline: a local bulk file.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { getPrinting, lookupCollector, openIndex, printingPriceEur, refreshIndex, storagePrinting } from "../lib/cardindex.js";
import { scanPriceEur } from "../lib/scanner.js";
import { tempDb } from "./fixtures.js";

const SETS = [{ code: "m15", name: "Magic 2015", set_type: "core", released_at: "2014-07-18", card_count: 284, printed_size: 269 }];
const card = (o) => ({
  object: "card", oracle_id: `o-${o.name}`, lang: "en", games: ["paper"], digital: false, released_at: "2014-07-18", rarity: "rare",
  finishes: ["nonfoil", "foil"], promo_types: [], illustration_id: `ill-${o.name}`, frame: "2015", border_color: "black", full_art: false,
  frame_effects: [], layout: "normal", image_status: "highres_scan", type_line: "Instant", mana_cost: "{R}", set: "m15", ...o,
});
const BOLT_EN = card({ id: "p-0001", name: "Lightning Bolt", collector_number: "155", prices: { eur: "1.50", eur_foil: "7.25", eur_etched: null, usd: "2.00" } });
const BOLT_DE = card({ id: "p-0002", name: "Lightning Bolt", collector_number: "155", lang: "de", printed_name: "Blitzschlag", prices: { eur: null, eur_foil: null, usd: null } });
const ETCHED = card({ id: "p-0003", name: "Etched Thing", collector_number: "300", finishes: ["etched"], prices: { eur_etched: "12" } });
const JUNK = card({ id: "p-0004", name: "Junk Price", collector_number: "301", prices: { eur: "abc", eur_foil: "-1" } });
const NOPRICES = card({ id: "p-0005", name: "No Prices", collector_number: "302" });

let dir, idx;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-prices-"));
  const file = path.join(dir, "all.jsonl.gz");
  writeFileSync(file, gzipSync([BOLT_EN, BOLT_DE, ETCHED, JUNK, NOPRICES].map((c) => JSON.stringify(c)).join("\n")));
  idx = openIndex(path.join(dir, "cardindex.db"));
  await refreshIndex(idx, { source: file, setsSource: SETS });
});
after(() => { try { idx.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

describe("index prices", () => {
  test("refreshIndex stores eur / eur_foil / eur_etched as numbers; junk and missing become null", () => {
    const en = getPrinting(idx, "p-0001");
    assert.equal(en.eur, 1.5);
    assert.equal(en.eur_foil, 7.25);
    assert.equal(en.eur_etched, null);
    const de = getPrinting(idx, "p-0002");
    assert.deepEqual([de.eur, de.eur_foil, de.eur_etched], [null, null, null]);
    assert.equal(getPrinting(idx, "p-0003").eur_etched, 12);
    const junk = getPrinting(idx, "p-0004");
    assert.deepEqual([junk.eur, junk.eur_foil], [null, null]);
    assert.equal(getPrinting(idx, "p-0005").eur, null);
    // the lookups carry the prices too (SELECT *)
    assert.equal(lookupCollector(idx, { set: "m15", number: "155", lang: "en" })[0].eur, 1.5);
  });

  test("printingPriceEur is finish-aware and never falls back to another finish", () => {
    const en = getPrinting(idx, "p-0001");
    assert.equal(printingPriceEur(en, "normal"), 1.5);
    assert.equal(printingPriceEur(en, "foil"), 7.25);
    assert.equal(printingPriceEur(en, "etched"), null);
    assert.equal(printingPriceEur(getPrinting(idx, "p-0003"), "etched"), 12);
    assert.equal(printingPriceEur(null, "normal"), null);
    assert.equal(printingPriceEur({ id: "x" }, "normal"), null, "an index without price columns");
  });

  test("openIndex adds the price columns to an older index, idempotently, keeping the rows", () => {
    const file = path.join(dir, "old.db");
    openIndex(file).close();
    const raw = new DatabaseSync(file);
    for (const c of ["eur", "eur_foil", "eur_etched"]) raw.exec(`ALTER TABLE printings DROP COLUMN ${c}`);
    raw.exec("INSERT INTO printings (id, name, lang, set_code, collector_number) VALUES ('old-1', 'Old Card', 'en', 'm15', '1')");
    raw.close();
    for (let i = 0; i < 2; i++) {
      const o = openIndex(file);
      const cols = o.prepare("PRAGMA table_info(printings)").all().map((c) => c.name);
      assert.ok(["eur", "eur_foil", "eur_etched"].every((c) => cols.includes(c)));
      const p = getPrinting(o, "old-1");
      assert.equal(p.name, "Old Card");
      assert.equal(p.eur, null);
      o.close();
    }
  });
});

describe("scanPriceEur", () => {
  const res = (store, finish = "normal", o = {}) => ({ status: "auto", printing: store, store, finish, ...o });

  test("index price of the stored printing for the decided finish", async () => {
    const en = getPrinting(idx, "p-0001");
    assert.deepEqual(await scanPriceEur(res(en)), { price_eur: 1.5, price_source: "index" });
    assert.deepEqual(await scanPriceEur(res(en, "foil")), { price_eur: 7.25, price_source: "index" });
    assert.deepEqual(await scanPriceEur(res(en, "nonfoil")), { price_eur: 1.5, price_source: "index" });
    assert.deepEqual(await scanPriceEur(res(getPrinting(idx, "p-0003"), "etched")), { price_eur: 12, price_source: "index" });
  });

  test("failed results and missing printings have no price", async () => {
    assert.deepEqual(await scanPriceEur({ status: "failed", printing: null }), { price_eur: null, price_source: null });
    assert.deepEqual(await scanPriceEur(null), { price_eur: null, price_source: null });
    assert.deepEqual(await scanPriceEur(res(getPrinting(idx, "p-0005"))), { price_eur: null, price_source: null });
  });

  test("falls back to the app cards table (EUR only, finish-aware), then to the English twin", async () => {
    const app = tempDb();
    try {
      const ins = app.db.prepare("INSERT INTO cards (scryfall_id, oracle_id, name, prices, fetched_at) VALUES (?, ?, ?, ?, 'x')");
      ins.run("p-0005", "o-No Prices", "No Prices", JSON.stringify({ eur: "3.10", eur_foil: null, usd: "9" }));
      ins.run("p-0004", "o-Junk", "Junk Price", JSON.stringify({ usd: "50" }));
      const np = getPrinting(idx, "p-0005");
      assert.deepEqual(await scanPriceEur(res(np), { db: app.db }), { price_eur: 3.1, price_source: "cards" });
      assert.deepEqual(await scanPriceEur(res(np, "foil"), { db: app.db }), { price_eur: null, price_source: null }, "no foil price, never USD");
      assert.deepEqual(await scanPriceEur(res(getPrinting(idx, "p-0004")), { db: app.db }), { price_eur: null, price_source: null });

      // German store printing: no price of its own, the English twin's
      const de = getPrinting(idx, "p-0002");
      const lookupEn = async (p) => storagePrinting(idx, p, "en");
      assert.deepEqual(await scanPriceEur(res(de, "foil"), { db: app.db, lookupEn }), { price_eur: 7.25, price_source: "index_en" });
      assert.deepEqual(await scanPriceEur(res(de), { db: app.db }), { price_eur: null, price_source: null }, "no lookup: no twin");
      const boom = async () => { throw new Error("worker gone"); };
      assert.deepEqual(await scanPriceEur(res(de), { db: app.db, lookupEn: boom }), { price_eur: null, price_source: null });
    } finally {
      app.cleanup();
    }
  });
});
