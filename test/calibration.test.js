// Calibration set for the Commander bracket and the 1-10 score (plan v0.7.0
// §5): published decklists with a known power level, run through the same
// path as a saved deck (Scryfall card objects → normalizeCard rows → power.js
// with the recorded Commander Spellbook answer through trimResult). Offline:
// every card and every Spellbook answer is a recorded fixture
// (test/fixtures/decks-calibration, sources in its NOTICE.md).
//
// Targets: auto bracket exact on every list, score inside its group's band on
// at least 11 of 12, group means strictly ordered and every precon below every
// cEDH list. The scores are pinned, so a change to the weights, the card
// classifier or the deck stats shows up here as a deliberate diff.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseDecklist } from "../lib/decks.js";
import { normalizeCard } from "../lib/scryfall.js";
import { spellbookRequest, trimResult } from "../lib/spellbook.js";
import { powerOf } from "../lib/power.js";

const DIR = new URL("./fixtures/decks-calibration/", import.meta.url);
const read = (f) => readFileSync(new URL(f, DIR), "utf8");
const INDEX = JSON.parse(read("index.json")).decks;
const CARDS = JSON.parse(read("cards.json")).cards;
const SPELLBOOK = JSON.parse(read("spellbook.json")).responses;

/** Score band per group (plan §5 calibration table). */
const BANDS = { precon: [3, 5], upgraded: [5, 7], optimized: [7, 9], cedh: [9, 10] };

/** Pinned scores (weights of 2026-10-16). */
const SCORES = {
  "precon-blight-curse": 4.4, "precon-lorehold-spirit": 3.6, "precon-doom-prevails": 3.9, "precon-temur-roar": 3.5,
  "upgraded-lorehold-spirit": 4.4, "upgraded-world-shaper": 5.4, "upgraded-blight-curse": 6.8,
  "optimized-chatterfang": 7.3, "optimized-edgar-markov": 7, "optimized-wilhelt": 8.8,
  "cedh-tymna-thrasios": 9.5, "cedh-vivi-storm": 9,
  "edge-precon-world-shaper": 5.4, "edge-upgraded-temur-roar": 4.6,
};

// Card rows as deckDetail selects them: name lookup by full name, then by a
// face name (a full name always wins: "Wheel of Fortune" is a card of its own
// and also the back face of a 2026 prepare card).
const BY_NAME = new Map();
const ROWS = CARDS.map((c) => [c, { ...normalizeCard(c), fetched_at: "2026-10-15T00:00:00.000Z" }]);
for (const [c, row] of ROWS) BY_NAME.set(c.name.toLowerCase(), row);
for (const [c, row] of ROWS) for (const f of c.card_faces ?? []) if (!BY_NAME.has(f.name.toLowerCase())) BY_NAME.set(f.name.toLowerCase(), row);

function load(label) {
  const text = read(`${label}.txt`);
  const { items, errors } = parseDecklist(text);
  const rows = items.map((i) => {
    const c = BY_NAME.get(i.name.toLowerCase());
    return c
      ? { ...c, board: i.board, name: c.name, card_name: c.name, quantity: i.quantity, companion: 0 }
      : { board: i.board, name: i.name, quantity: i.quantity, scryfall_id: null, companion: 0 };
  });
  const request = spellbookRequest(rows, { isCommander: true });
  const combos = { status: "ok", fetched_at: "2026-10-15T00:00:00.000Z", result: trimResult(SPELLBOOK[label], request.names) };
  return { text, errors, rows, request, combos, power: powerOf({ format: null, source: "manabox" }, rows, { combos }) };
}

const DECKS = Object.fromEntries(INDEX.map((d) => [d.label, { ...d, ...load(d.label) }]));
const core = INDEX.filter((d) => d.group !== "edge").map((d) => DECKS[d.label]);
const inBand = (d) => d.power.score.value >= BANDS[d.group][0] && d.power.score.value <= BANDS[d.group][1];
const mean = (group) => {
  const list = core.filter((d) => d.group === group).map((d) => d.power.score.value);
  return list.reduce((s, v) => s + v, 0) / list.length;
};

describe("calibration fixtures", () => {
  test("12 calibration lists + 2 edge cases, 100 cards each, every name resolved, sourced", () => {
    assert.equal(core.length, 12);
    assert.deepEqual(Object.fromEntries(["precon", "upgraded", "optimized", "cedh"].map((g) => [g, core.filter((d) => d.group === g).length])),
      { precon: 4, upgraded: 3, optimized: 3, cedh: 2 });
    const files = readdirSync(DIR).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, "")).sort();
    assert.deepEqual(files, INDEX.map((d) => d.label).sort());
    const notice = read("NOTICE.md");
    for (const d of Object.values(DECKS)) {
      assert.deepEqual(d.errors, [], d.label);
      assert.match(d.text, /^\/\/ Source: \S+/m, `${d.label}: source line`);
      assert.ok(notice.includes(`\`${d.label}.txt\``), `${d.label}: credited in NOTICE.md`);
      assert.equal(d.rows.reduce((s, r) => s + r.quantity, 0), 100, d.label);
      assert.deepEqual(d.rows.filter((r) => !r.scryfall_id).map((r) => r.name), [], `${d.label}: unresolved`);
      assert.deepEqual(d.combos.result.unresolved, [], `${d.label}: Spellbook knew every name`);
      assert.ok(SPELLBOOK[d.label].cards.length > 0, d.label);
    }
  });
});

describe("calibration: bracket", () => {
  test("auto bracket exact on every list (format NULL, commander board → detected)", () => {
    for (const d of Object.values(DECKS)) {
      const b = d.power.bracket;
      assert.equal(d.power.commander, true, d.label);
      assert.equal(b.auto, d.expected, `${d.label}: ${b.reasons.map((r) => r.text).join(" | ")}`);
      assert.equal(b.partial, false, d.label);
      assert.equal(b.declared, null);
      assert.equal(b.legality.ok, true, `${d.label}: ${b.legality.problems.map((p) => p.text).join("; ")}`);
    }
  });

  test("the reasons name what set the bracket", () => {
    const why = (label) => DECKS[label].power.bracket.reasons.filter((r) => r.floor === DECKS[label].power.bracket.auto).map((r) => r.rule);
    for (const label of ["precon-blight-curse", "precon-lorehold-spirit", "precon-doom-prevails", "precon-temur-roar"]) assert.deepEqual(why(label), ["base"], label);
    assert.deepEqual(why("upgraded-lorehold-spirit"), ["game_changers"]); // 3 Game Changers
    assert.ok(why("upgraded-world-shaper").includes("game_changers"));
    // Only 3 Game Changers, and its 2-card combo (Chatterfang + Pitiless Plunderer, both on the
    // battlefield: 8 mana to assemble) is a late one: Bracket 3 by the rules, whatever its author calls it.
    assert.ok(why("optimized-chatterfang").includes("game_changers"));
    assert.ok(DECKS["optimized-chatterfang"].power.bracket.reasons.some((r) => r.rule === "combo" && r.floor === 3 && /\(8 mana\)$/.test(r.text)));
    assert.deepEqual(new Set(why("optimized-edgar-markov")), new Set(["game_changers", "mld"]));
    for (const label of ["optimized-wilhelt", "cedh-tymna-thrasios", "cedh-vivi-storm"]) assert.ok(why(label).includes("game_changers"), label);
  });

  test("cEDH hint: both cEDH lists, never a precon or an upgraded precon", () => {
    for (const d of core) {
      if (d.group === "cedh") assert.equal(d.power.bracket.cedh_hint, true, d.label);
      if (d.group === "precon" || d.group === "upgraded") assert.equal(d.power.bracket.cedh_hint, false, d.label);
      assert.notEqual(d.power.bracket.value, 5, "B5 is never automatic");
    }
  });

  test("Spellbook's tag never raises ours (cEDH lists: Ruthless ≈4, our 4)", () => {
    assert.equal(DECKS["cedh-vivi-storm"].combos.result.tag, "R");
    assert.equal(DECKS["cedh-vivi-storm"].power.bracket.auto, 4);
    // the precons: Exhibition (≈1) from Spellbook, 2 from the rules
    for (const label of ["precon-blight-curse", "precon-temur-roar"]) assert.equal(DECKS[label].combos.result.tag, "E");
  });

  test("edge: a precon with an arguably-two-card combo is Bracket 3, marked borderline", () => {
    const b = DECKS["edge-precon-world-shaper"].power.bracket;
    const combo = b.reasons.find((r) => r.rule === "combo");
    assert.equal(combo.floor, 3);
    assert.equal(combo.borderline, true);
    assert.deepEqual(combo.cards.map((c) => c.name).sort(), ["Dakmor Salvage", "The Gitrog Monster"]);
    assert.equal(DECKS["edge-precon-world-shaper"].combos.result.tag, "S", "Spellbook agrees: Spicy ≈3");
  });

  test("edge: an upgrade its author calls Bracket 3 with no Game Changer or combo stays 2 (intent is the user's call)", () => {
    const d = DECKS["edge-upgraded-temur-roar"];
    assert.match(d.text, /author's bracket 3/);
    assert.equal(d.power.bracket.auto, 2);
    assert.deepEqual(d.power.bracket.reasons.map((r) => r.rule), ["base"]);
  });
});

describe("calibration: score", () => {
  test("pinned scores (weights 2026-10-16)", () => {
    for (const d of Object.values(DECKS)) assert.equal(d.power.score.value, SCORES[d.label], d.label);
  });

  test("≥ 11 of 12 inside their band; the known miss is the lightly upgraded Lorehold deck", () => {
    const misses = core.filter((d) => !inBand(d)).map((d) => `${d.label} ${d.power.score.value}`);
    assert.ok(core.length - misses.length >= 11, misses.join(", "));
    assert.deepEqual(misses, ["upgraded-lorehold-spirit 4.4"]);
  });

  test("group means strictly ordered, every precon below every cEDH list", () => {
    assert.ok(mean("precon") < mean("upgraded"), `${mean("precon")} < ${mean("upgraded")}`);
    assert.ok(mean("upgraded") < mean("optimized"), `${mean("upgraded")} < ${mean("optimized")}`);
    assert.ok(mean("optimized") < mean("cedh"), `${mean("optimized")} < ${mean("cedh")}`);
    const maxPrecon = Math.max(...core.filter((d) => d.group === "precon").map((d) => d.power.score.value));
    const minCedh = Math.min(...core.filter((d) => d.group === "cedh").map((d) => d.power.score.value));
    assert.ok(maxPrecon < minCedh);
  });

  test("checked combos only add: offline scores are lower or equal and partial", () => {
    for (const d of core) {
      const off = powerOf({ format: "commander" }, d.rows, { combos: { status: "offline", fetched_at: null, result: null } });
      assert.ok(off.score.value <= d.power.score.value, d.label);
      assert.equal(off.score.partial, true);
      assert.equal(off.bracket.partial, true);
      assert.ok(off.bracket.auto <= d.power.bracket.auto, d.label);
    }
  });
});
