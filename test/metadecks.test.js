// MTGO tournament lists (lib/metadecks.js): page parsing, archetypes, refresh + cache, comparison.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { archetypeShares, compareToMeta, metaDecks, parseMtgoEvent, pauperArchetype, refreshMetaDecks } from "../lib/metadecks.js";
import { tempDb } from "./fixtures.js";
import { stubWeb } from "./helpers/web.js";

const card = (name, qty) => ({ qty: String(qty), card_attributes: { card_name: name } });
const FAERIES = [card("Spellstutter Sprite", 4), card("Faerie Seer", 4), card("Baleful Strix", 4), card("Counterspell", 4), card("Snuff Out", 2), card("Island", 10)];
const BURN = [card("Guttersnipe", 4), card("Fiery Temper", 4), card("Lightning Bolt", 4), card("Fireblast", 2), card("Mountain", 16)];
const page = (description, lists, standings = []) => `<html><script>
window.MTGO.decklists.data = ${JSON.stringify({ description, starttime: "2026-10-19 17:00:00.0", format: "CPAUPER",
    decklists: lists.map(([player, main, side = []], i) => ({ loginid: String(i + 1), player, main_deck: main, sideboard_deck: side })), standings })};
window.MTGO.decklists.type = "x";
</script></html>`;

let ctx;
before(() => { ctx = tempDb(); });
after(() => ctx.cleanup());

test("parseMtgoEvent: players, cards, standings (Challenge) or 5-0 (League)", () => {
  const ev = parseMtgoEvent(page("Pauper Challenge 32", [["ann", FAERIES, [card("Hydroblast", 3)]], ["bob", BURN]], [{ loginid: "2", rank: 1 }, { loginid: "1", rank: 7 }]));
  assert.equal(ev.date, "2026-10-19");
  assert.equal(ev.format, "pauper");
  assert.deepEqual(ev.decks.map((d) => [d.player, d.placing]), [["ann", "7"], ["bob", "1"]]);
  assert.deepEqual(ev.decks[0].side, [{ name: "Hydroblast", quantity: 3 }]);
  assert.equal(parseMtgoEvent(page("Pauper League", [["cy", BURN]])).decks[0].placing, "5-0");
  assert.throws(() => parseMtgoEvent("<html></html>"), /no decklist data/);
});

test("pauperArchetype: best signature match with ≥ 3 cards, sideboard ignored, else Other", () => {
  assert.equal(pauperArchetype(["Spellstutter Sprite", "Faerie Seer", "Baleful Strix", "Counterspell"]), "Dimir Faeries");
  assert.equal(pauperArchetype([{ name: "Guttersnipe", board: "main" }, { name: "Fireblast", board: "main" }, { name: "Lava Dart", board: "main" }]), "Red Deck Wins");
  assert.equal(pauperArchetype([{ name: "Guttersnipe", board: "main" }, { name: "Fireblast", board: "side" }, { name: "Lava Dart", board: "side" }]), "Other");
});

test("refreshMetaDecks: new events only, cached for 3 days, MTGO errors reported", async () => {
  const web = stubWeb([
    [/mtgo\.com\/decklists$/, () => '<a href="/decklist/pauper-challenge-32-2026-10-19">x</a><a href="/decklist/pauper-league-2026-10-20">y</a><a href="/decklist/modern-league-1">z</a>'],
    [/pauper-challenge-32/, () => page("Pauper Challenge 32", [["ann", FAERIES], ["bob", BURN], ["dan", FAERIES]], [{ loginid: "1", rank: 1 }])],
    [/pauper-league/, () => page("Pauper League", [["eve", FAERIES], ["fay", FAERIES], ["gus", FAERIES], ["hal", FAERIES], ["ivy", BURN]])],
  ]);
  try {
    assert.deepEqual(await refreshMetaDecks(ctx.db, { pauseMs: 0 }), { checked: true, added: 8 });
    assert.ok(!web.calls.some((u) => /modern/.test(u)));
    const n = web.calls.length;
    assert.deepEqual(await refreshMetaDecks(ctx.db, { pauseMs: 0 }), { checked: false, added: 0 });
    assert.equal(web.calls.length, n);
    assert.deepEqual(await refreshMetaDecks(ctx.db, { pauseMs: 0, force: true }), { checked: true, added: 0 }, "known events are not fetched again");
    assert.equal(web.calls.length, n + 1);
  } finally {
    web.restore();
  }
  const err = stubWeb([]);
  try {
    const r = await refreshMetaDecks(ctx.db, { pauseMs: 0, force: true });
    assert.match(r.error, /mtgo\.com 404/);
  } finally {
    err.restore();
  }
  const decks = metaDecks(ctx.db);
  assert.equal(decks.length, 8);
  assert.deepEqual(archetypeShares(decks).map((s) => [s.archetype, s.decks, s.pct]), [["Dimir Faeries", 6, 75], ["Red Deck Wins", 2, 25]]);
});

test("compareToMeta: archetype peers, missing staples, fewer copies, rare picks", () => {
  const faerie = (extra = []) => ({ archetype: "Dimir Faeries", main: [{ name: "Spellstutter Sprite", quantity: 4 }, { name: "Faerie Seer", quantity: 4 }, { name: "Counterspell", quantity: 4 }, { name: "Island", quantity: 12 }, ...extra] });
  const decks = [faerie(), faerie(), faerie(), faerie(), faerie([{ name: "Snuff Out", quantity: 2 }]), { archetype: "Other", main: [{ name: "Mountain", quantity: 20 }] }];
  const rows = [
    { board: "main", name: "Spellstutter Sprite", quantity: 4 }, { board: "main", name: "Faerie Seer", quantity: 2 },
    { board: "main", name: "Augur of Bolas", quantity: 3 }, { board: "main", name: "Island", quantity: 14 }, { board: "main", name: "Weird Pick", quantity: 1 },
  ];
  const r = compareToMeta(decks, rows);
  assert.equal(r.archetype, "Dimir Faeries");
  assert.equal(r.peers, 5);
  assert.deepEqual(r.missing.map((c) => [c.name, c.pct, c.copies]), [["Counterspell", 100, 4]]);
  assert.deepEqual(r.fewer.map((c) => [c.name, c.mine, c.copies]), [["Faerie Seer", 2, 4]]);
  assert.deepEqual(r.rare, ["Augur of Bolas", "Weird Pick"]);
});
