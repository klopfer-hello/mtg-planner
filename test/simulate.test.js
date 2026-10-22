// Goldfish simulator (lib/simulate.js): determinism, the mana model's main
// effects (ramp, colour sources, no lands), combos with tutors and the speed
// budget. Rows are synthetic, shaped like deckDetail's `cards`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { simulateDeck, simulationText } from "../lib/simulate.js";

/** A deck row; overrides win. */
const row = (o) => ({
  board: "main", quantity: 1, layout: "normal", type_line: "Creature — Bear", mana_cost: "{1}{G}", cmc: 2,
  color_identity: "G", oracle_text: "", keywords: "[]", produced_mana: null, ...o,
});
const basic = (type, c, quantity) => row({
  name: type, quantity, type_line: `Basic Land — ${type}`, mana_cost: "", cmc: 0, color_identity: c,
  oracle_text: `({T}: Add {${c}}.)`, produced_mana: JSON.stringify([c]),
});
const bear = (name, quantity = 1, o = {}) => row({ name, quantity, ...o });
const rock = (name) => row({
  name, type_line: "Artifact", mana_cost: "{2}", cmc: 2, color_identity: "", oracle_text: "{T}: Add {C}.", produced_mana: '["C"]',
});
const commander = row({ board: "commander", name: "Big Giant", type_line: "Legendary Creature — Giant", mana_cost: "{3}{G}{G}", cmc: 5 });

/** 37 Forests + 10 rocks (or 10 vanilla 2-drops) + 52 three-drops + a 5-MV commander. */
function rampDeck(withRocks) {
  const tens = Array.from({ length: 10 }, (_, i) => (withRocks ? rock(`Rock ${i}`) : bear(`Bear ${i}`)));
  return [commander, basic("Forest", "G", 37), ...tens, bear("Trolls", 52, { mana_cost: "{2}{G}", cmc: 3 })];
}
/** 60 cards: 17 lands (Plains only, or 9 Plains + 8 Islands), 22 white and 21 blue two-drops. */
function twoColour(balanced) {
  const lands = balanced ? [basic("Plains", "W", 9), basic("Island", "U", 8)] : [basic("Plains", "W", 17)];
  return [...lands, bear("Knight", 22, { mana_cost: "{1}{W}", color_identity: "W" }), bear("Wizard", 21, { mana_cost: "{1}{U}", color_identity: "U" })];
}
const tutor = (name) => row({
  name, type_line: "Sorcery", mana_cost: "{1}{G}", cmc: 2,
  oracle_text: "Search your library for a card, put that card into your hand, then shuffle.",
});
/** A Commander deck holding a two-card combo, with 8 tutors or 8 vanilla two-drops. */
function comboDeck(withTutors) {
  const eight = Array.from({ length: 8 }, (_, i) => (withTutors ? tutor(`Tutor ${i}`) : bear(`Filler ${i}`)));
  return [commander, basic("Forest", "G", 36), bear("Combo Piece A"), bear("Combo Piece B"), ...eight, bear("Trolls", 53, { mana_cost: "{2}{G}", cmc: 3 })];
}
const COMBO = [["Combo Piece A", "Combo Piece B"]];

describe("simulateDeck", () => {
  test("deterministic: same seed same result, default seed independent of row order", () => {
    const deck = rampDeck(true);
    const a = simulateDeck(deck, { games: 2000, seed: 42 });
    assert.deepEqual(simulateDeck(deck, { games: 2000, seed: 42 }), a);
    assert.equal(a.seed, 42);
    const d1 = simulateDeck(deck, { games: 2000 });
    const d2 = simulateDeck([...deck].reverse(), { games: 2000 });
    assert.deepEqual(d2, d1);
    assert.notEqual(simulateDeck(rampDeck(false), { games: 10 }).seed, d1.seed);
    assert.equal(d1.cards, 99);
    assert.equal(d1.lands, 37);
    assert.equal(d1.commander_deck, true);
  });

  test("mana rocks cast a 5-MV commander earlier than vanilla two-drops", () => {
    const rocks = simulateDeck(rampDeck(true), { games: 4000 });
    const bears = simulateDeck(rampDeck(false), { games: 4000 });
    assert.equal(rocks.commander.name, "Big Giant");
    assert.equal(rocks.commander.mv, 5);
    assert.ok(rocks.commander.by_turn[4] > bears.commander.by_turn[4] + 10, `${rocks.commander.by_turn[4]} vs ${bears.commander.by_turn[4]}`);
    assert.ok(rocks.commander.on_curve > bears.commander.on_curve);
    assert.ok(rocks.commander.median_turn <= bears.commander.median_turn);
    assert.equal(bears.commander.by_turn[4], 0); // no ramp: 5 mana needs 5 land drops
    const sum = (a) => a.reduce((s, n) => s + n, 0);
    assert.ok(sum(rocks.mana_by_turn) > sum(bears.mana_by_turn));
    assert.deepEqual(Object.keys(rocks.commander.by_turn).map(Number), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("one-colour lands in a two-colour deck: far more colour screw", () => {
    const skewed = simulateDeck(twoColour(false), { games: 4000 });
    const balanced = simulateDeck(twoColour(true), { games: 4000 });
    assert.ok(skewed.color_screw_t4 > balanced.color_screw_t4 + 30, `${skewed.color_screw_t4} vs ${balanced.color_screw_t4}`);
    assert.equal(skewed.commander, null);
    assert.equal(skewed.commander_deck, false);
    assert.equal(skewed.cards, 60);
  });

  test("no lands: no crash, nothing on curve, never keeps", () => {
    const r = simulateDeck([bear("Bear", 60)], { games: 500 });
    assert.equal(r.lands_on_curve.t3, 0);
    assert.equal(r.lands_on_curve.t4, 0);
    assert.equal(r.keep_rate, 0);
    assert.equal(r.mulligans_avg, 2);
    assert.deepEqual(r.mana_by_turn, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.doesNotThrow(() => simulateDeck([], { games: 10 }));
  });

  test("maybe and side boards are ignored, unresolved rows are MV-3 spells", () => {
    const deck = [...twoColour(true), bear("Side", 15, { board: "side" }), bear("Maybe", 5, { board: "maybe" }), { board: "main", name: "Unknown Card", quantity: 1 }];
    const r = simulateDeck(deck, { games: 200 });
    assert.equal(r.cards, 61);
    assert.equal(r.lands, 17);
  });

  test("combos: metric present only when given, tutors assemble faster", () => {
    assert.equal(simulateDeck(comboDeck(true), { games: 100 }).combo, null);
    const fast = simulateDeck(comboDeck(true), { games: 4000, combos: COMBO });
    const slow = simulateDeck(comboDeck(false), { games: 4000, combos: COMBO });
    assert.equal(fast.combo.lines, 1);
    assert.ok(fast.combo.by_t8 > slow.combo.by_t8 + 15, `${fast.combo.by_t8} vs ${slow.combo.by_t8}`);
    assert.ok(fast.combo.by_t6 > slow.combo.by_t6);
    const missing = simulateDeck(comboDeck(true), { games: 100, combos: [["Combo Piece A", "Not In Deck"]] });
    assert.deepEqual(missing.combo, { lines: 0, median_turn: null, by_t6: 0, by_t8: 0 });
  });

  test("simulationText carries the key numbers", () => {
    const r = simulateDeck(comboDeck(true), { games: 1000, seed: 7, combos: COMBO });
    const text = simulationText(r);
    const lines = text.split("\n");
    assert.ok(lines.length >= 2 && lines.length <= 4);
    assert.match(text, /Goldfish \(1000 games, seed 7/);
    assert.ok(text.includes(`keep ${Math.round(r.keep_rate)}%`));
    assert.ok(text.includes(`colour screw T4 ${Math.round(r.color_screw_t4)}%`));
    assert.ok(text.includes(`Commander Big Giant (MV 5): cast by T5 ${Math.round(r.commander.on_curve)}%`));
    assert.ok(text.includes(`by T4 ${Math.round(r.commander.by_turn[4])}%`));
    assert.ok(text.includes(`by T6 ${Math.round(r.combo.by_t6)}%`));
    assert.ok(!simulationText(simulateDeck(twoColour(true), { games: 100 })).includes("Commander"));
  });

  test("10 000 games of a 100-card deck stay fast", () => {
    const deck = comboDeck(true);
    const t0 = performance.now();
    const r = simulateDeck(deck, { combos: COMBO });
    const ms = performance.now() - t0;
    assert.equal(r.games, 10000);
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
    console.log(`simulateDeck: 10000 games in ${ms.toFixed(0)} ms`);
  });
});
