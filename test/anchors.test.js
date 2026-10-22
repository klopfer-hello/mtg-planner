// lib/anchorstats.js (#069): one deck's metrics with the app's classifier on hand-made `cards` rows, the quantile
// cells, the bracket → format-wide fallback, and the shape of the committed lib/anchors.json (built offline by
// scripts/anchors.mjs, which is not part of the suite: it needs the network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deckMetrics, aggregate, anchorFor, quantile, MIN_CELL_N } from "../lib/anchorstats.js";

let id = 0;
const card = (name, type_line, extra = {}) => ({
  scryfall_id: `id-${++id}`, fetched_at: "2026-10-22", name, type_line, cmc: 0, mana_cost: "", oracle_text: "",
  keywords: "[]", produced_mana: null, layout: "normal", colors: "", color_identity: "", game_changer: 0, ...extra,
});
const row = (c, board, quantity) => ({ ...c, board, quantity });

const FOREST = card("Forest", "Basic Land — Forest", { produced_mana: '["G"]', color_identity: "G" });
const ISLAND = card("Island", "Basic Land — Island", { produced_mana: '["U"]', color_identity: "U" });
const HARBOR = card("Hinterland Harbor", "Land", { produced_mana: '["G","U"]', color_identity: "GU", oracle_text: "{T}: Add {G} or {U}." });
const ELVES = card("Llanowar Elves", "Creature — Elf Druid", { cmc: 1, mana_cost: "{G}", colors: "G", color_identity: "G", oracle_text: "{T}: Add {G}.", produced_mana: '["G"]' });
const COUNTER = card("Counterspell", "Instant", { cmc: 2, mana_cost: "{U}{U}", colors: "U", color_identity: "U", oracle_text: "Counter target spell." });
const DIVINATION = card("Divination", "Sorcery", { cmc: 3, mana_cost: "{2}{U}", colors: "U", color_identity: "U", oracle_text: "Draw two cards." });
const OPT = card("Opt", "Instant", { cmc: 1, mana_cost: "{U}", colors: "U", color_identity: "U", oracle_text: "Scry 1.\nDraw a card." });
const MDFC = card("Turntimber Symbiosis // Turntimber, Serpentine Wood", "Sorcery // Land — Forest", {
  cmc: 7, mana_cost: "{4}{G}{G}{G} // ", layout: "modal_dfc", colors: "G", color_identity: "G",
  oracle_text: "Look at the top seven cards of your library.\n//\n{T}: Add {G}.", produced_mana: '["G"]',
});
const CMDR = card("Tatyova, Benthic Druid", "Legendary Creature — Merfolk Druid", { cmc: 5, mana_cost: "{3}{G}{U}", colors: "GU", color_identity: "GU" });

test("deckMetrics: a Commander deck counts copies per role with the app's classifier", () => {
  const m = deckMetrics([
    row(CMDR, "commander", 1), row(FOREST, "main", 30), row(HARBOR, "main", 2), row(ELVES, "main", 4),
    row(COUNTER, "main", 1), row(DIVINATION, "main", 1), row(OPT, "main", 1), row(MDFC, "main", 1),
    row(DIVINATION, "maybe", 3),
  ]);
  assert.equal(m.lands, 32);
  assert.equal(m.mdfc_lands, 1, "spell // land is a flex land, not a land");
  assert.equal(m.ramp, 4);
  assert.equal(m.draw, 1);
  assert.equal(m.cantrips, 1);
  assert.equal(m.counters, 1);
  assert.equal(m.cheap_plays, 6, "nonland MV ≤ 2 in the main deck: 4 Elves, Counterspell, Opt");
  assert.equal(m.avg_mv, 2.13, "deckStats: nonland, front face, commander and maybe left out");
  assert.equal(m.fixing_lands, 2, "only the dual makes two identity colours");
  assert.equal(m.colors, 2);
  assert.ok(!("four_ofs" in m) && !("sideboard" in m), "60-card fields only without a commander");
});

test("deckMetrics: a 60-card deck gets four_ofs and sideboard; mono colour has no fixing number", () => {
  const m = deckMetrics([
    row(ISLAND, "main", 16), row(ISLAND, "main", 4), row(COUNTER, "main", 4), row(OPT, "main", 4), row(DIVINATION, "main", 3),
    row(COUNTER, "side", 2), row(OPT, "side", 1),
  ]);
  assert.equal(m.lands, 20);
  assert.equal(m.four_ofs, 2, "Counterspell and Opt; basics never count");
  assert.equal(m.sideboard, 3);
  assert.equal(m.counters, 4, "side copies are not played");
  assert.equal(m.fixing_lands, null);
  assert.equal(m.colors, 1);
});

test("aggregate: quartiles rounded to 1 decimal, nulls skipped with their own n", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const cell = aggregate([{ a: 1, b: null }, { a: 2, b: 5 }, { a: 3, b: 6 }, { a: 4, b: 7 }]);
  assert.equal(cell.n, 4);
  assert.deepEqual(cell.metrics.a, { p25: 1.8, median: 2.5, p75: 3.3 });
  assert.deepEqual(cell.metrics.b, { p25: 5.5, median: 6, p75: 6.5, n: 3 });
  assert.deepEqual(aggregate([]), { n: 0, metrics: {} });
});

test("anchorFor: the bracket cell when it is big enough, else the format-wide cell", () => {
  const metrics = { lands: { p25: 35, median: 37, p75: 38 } };
  const anchors = { cells: { commander: { n: 200, metrics }, "commander:b3": { n: 40, metrics }, "commander:b1": { n: MIN_CELL_N - 1, metrics } } };
  assert.deepEqual(anchorFor(anchors, { format: "Commander ", bracket: 3 }), { key: "commander:b3", n: 40, metrics, fallback: false, wanted: "commander:b3" });
  assert.equal(anchorFor(anchors, { format: "commander", bracket: 1 }).key, "commander", "n < 30 falls back");
  assert.equal(anchorFor(anchors, { format: "commander", bracket: 1 }).fallback, true);
  assert.equal(anchorFor(anchors, { format: "commander", bracket: 9 }).key, "commander", "missing cell falls back");
  assert.equal(anchorFor(anchors, { format: "commander" }).fallback, false);
  assert.equal(anchorFor(anchors, { format: "modern" }), null);
  assert.equal(anchorFor(null, { format: "commander" }), null);
});

test("lib/anchors.json: committed shape, sizes and plausible medians", () => {
  const a = JSON.parse(readFileSync(new URL("../lib/anchors.json", import.meta.url), "utf8"));
  assert.equal(a.version, 1);
  assert.match(a.generated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(a.sources.length >= 3 && a.sources.every((s) => s.name && /^https:\/\//.test(s.url) && s.decks > 0 && s.note));
  for (const k of ["commander", "commander:b2", "commander:b3", "commander:b4", "commander:b5", "pauper"]) {
    const c = a.cells[k];
    assert.ok(c, `cell ${k}`);
    assert.ok(Number.isInteger(c.n) && c.n > 0, `${k} n`);
    for (const m of ["lands", "ramp", "draw", "removal", "wipes", "cheap_plays", "avg_mv", "fixing_lands"]) {
      const q = c.metrics[m];
      assert.ok(q && q.p25 <= q.median && q.median <= q.p75, `${k}.${m} ordered quartiles`);
      for (const v of [q.p25, q.median, q.p75]) assert.equal(Math.round(v * 10) / 10, v, `${k}.${m} 1 decimal`);
    }
  }
  for (const k of ["commander", "commander:b2", "commander:b3", "commander:b4", "pauper"]) assert.ok(a.cells[k].n >= MIN_CELL_N, `${k} quotable`);
  assert.ok(a.cells.commander.metrics.lands.median >= 33 && a.cells.commander.metrics.lands.median <= 39);
  assert.ok(a.cells.pauper.metrics.lands.median >= 15 && a.cells.pauper.metrics.lands.median <= 22);
  assert.ok("four_ofs" in a.cells.pauper.metrics && !("four_ofs" in a.cells.commander.metrics));
  assert.ok(anchorFor(a, { format: "commander", bracket: 3 }));
});
