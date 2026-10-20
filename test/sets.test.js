// Set completion: index side (setCompletion / setChecklist) and app side (listSets / setDetail).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import * as cardindex from "../lib/cardindex.js";
import { listSets, setDetail } from "../lib/sets.js";
import { tempDb } from "./fixtures.js";

const SETS = [
  { code: "tst", name: "Test Set", set_type: "expansion", released_at: "2024-08-02", card_count: 6, printed_size: null },
  { code: "old", name: "Old Set", set_type: "core", released_at: "2010-07-16", card_count: 1, printed_size: 1 },
  { code: "ttst", name: "Test Set Tokens", set_type: "token", released_at: "2024-08-02", card_count: 1, parent_set_code: "tst" },
];
const card = (o) => ({
  object: "card", lang: "en", games: ["paper"], digital: false, released_at: "2024-08-02", rarity: "common", finishes: ["nonfoil"],
  promo_types: [], illustration_id: `ill-${o.id}`, frame: "2015", border_color: "black", full_art: false, frame_effects: [],
  layout: "normal", image_status: "highres_scan", type_line: "Instant", mana_cost: "{R}", set: "tst",
  image_uris: { small: `https://img/${o.id}.jpg` }, ...o,
});
const PRINTINGS = [
  card({ id: "a-1", oracle_id: "o-a", name: "Alpha", collector_number: "1", prices: { eur: "1.00" } }),
  card({ id: "a-300", oracle_id: "o-a", name: "Alpha", collector_number: "300", border_color: "borderless", prices: { eur: "5.00" } }),
  card({ id: "a-1-de", oracle_id: "o-a", name: "Alpha", collector_number: "1", lang: "de", printed_name: "Alpha DE", prices: {} }),
  card({ id: "b-2", oracle_id: "o-b", name: "Beta", collector_number: "2", rarity: "rare", prices: { eur: "2.50" } }),
  card({ id: "c-3", oracle_id: "o-c", name: "Gamma", collector_number: "3", prices: {} }),
  card({ id: "t-1", oracle_id: "o-t", name: "Goblin", collector_number: "1", set: "ttst", layout: "token", type_line: "Token Creature", prices: {} }),
  card({ id: "b-old", oracle_id: "o-b", name: "Beta", collector_number: "1", set: "old", released_at: "2010-07-16", prices: { eur: "0.30" } }),
];

let dir, idx, ctx;
const indexCall = async (fn, ...args) => cardindex[fn](idx, ...args);
const own = (id, set, cn, oracle, name, qty, o = {}) => {
  ctx.db.prepare("INSERT OR IGNORE INTO cards (scryfall_id, oracle_id, name, set_code, collector_number, lang, fetched_at) VALUES (?, ?, ?, ?, ?, ?, '')")
    .run(id, oracle, name, set, cn, o.lang ?? "en");
  ctx.db.prepare("INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity) VALUES (?, ?, ?, 'near_mint', '', ?)")
    .run(id, o.finish ?? "normal", o.lang ?? "en", qty);
};

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-sets-"));
  const file = path.join(dir, "all.jsonl.gz");
  writeFileSync(file, gzipSync(PRINTINGS.map((c) => JSON.stringify(c)).join("\n")));
  idx = cardindex.openIndex(path.join(dir, "cardindex.db"));
  await cardindex.refreshIndex(idx, { source: file, setsSource: SETS });
  ctx = tempDb();
  own("a-300", "tst", "300", "o-a", "Alpha", 2, { finish: "foil" }); // the borderless variant counts for Alpha
  own("a-1-de", "tst", "1", "o-a", "Alpha", 1, { lang: "de" });
  own("b-old", "old", "1", "o-b", "Beta", 3); // Beta only from another set
  own("t-1", "ttst", "1", "o-t", "Goblin", 1);
});
after(() => { try { idx.close(); } catch { /* closed */ } ctx?.cleanup(); rmSync(dir, { recursive: true, force: true }); });

describe("set completion", () => {
  test("setCompletion counts distinct cards of a set (any printing/language), leaves tokens out, prices the missing ones", () => {
    const rows = cardindex.setCompletion(idx, { tst: ["o-a"], nope: ["x"] });
    assert.equal(rows.length, 1, "unknown sets are left out");
    assert.deepEqual({ ...rows[0] }, {
      code: "tst", name: "Test Set", set_type: "expansion", parent_set_code: null, released_at: "2024-08-02",
      cards: 3, owned: 1, missing: 2, missing_eur: 2.5, unpriced: 1,
    });
    assert.deepEqual(cardindex.setCompletion(idx, { ttst: ["o-t"] }), [], "a token set has no cards");
  });

  test("setChecklist: one row per card, cheapest English printing, sorted by number", () => {
    const list = cardindex.setChecklist(idx, "TST");
    assert.equal(list.set.code, "tst");
    assert.deepEqual(list.cards.map((c) => [c.name, c.collector_number, c.eur, c.id, c.printings]), [
      ["Alpha", "1", 1, "a-1", 2], ["Beta", "2", 2.5, "b-2", 1], ["Gamma", "3", null, "c-3", 1],
    ]);
    assert.equal(cardindex.setChecklist(idx, "zzz"), null);
  });

  test("listSets: owned sets newest first; a token set has no cards to complete; hidden set types only with all", async () => {
    const { sets, hidden } = await listSets(ctx.db, indexCall);
    assert.equal(hidden, 0);
    assert.deepEqual(sets.map((s) => [s.code, s.owned, s.cards, s.pct, s.copies]), [["tst", 1, 3, 33.3, 3], ["old", 1, 1, 100, 3]]);
    idx.prepare("UPDATE sets SET set_type = 'memorabilia' WHERE code = 'old'").run();
    try {
      const some = await listSets(ctx.db, indexCall);
      assert.deepEqual([some.sets.map((s) => s.code), some.hidden], [["tst"], 1]);
      const every = await listSets(ctx.db, indexCall, { all: true });
      assert.deepEqual([every.sets.map((s) => s.code), every.hidden], [["tst", "old"], 0]);
    } finally {
      idx.prepare("UPDATE sets SET set_type = 'core' WHERE code = 'old'").run();
    }
  });

  test("setDetail: owned copies, languages and finishes per card, copies from other sets, totals", async () => {
    const d = await setDetail(ctx.db, indexCall, "tst");
    const by = Object.fromEntries(d.cards.map((c) => [c.name, c]));
    assert.deepEqual([by.Alpha.owned, by.Alpha.langs, by.Alpha.finishes, by.Alpha.elsewhere], [3, ["de", "en"], ["foil", "normal"], 0]);
    assert.ok(["a-300", "a-1-de"].includes(by.Alpha.owned_id));
    assert.deepEqual([by.Beta.owned, by.Beta.elsewhere, by.Beta.owned_id], [0, 3, null]);
    assert.deepEqual(d.totals, { cards: 3, owned: 1, missing: 2, missing_eur: 2.5, unpriced: 1, pct: 33.3 });
    assert.equal(await setDetail(ctx.db, indexCall, "zzz"), null);
  });
});
