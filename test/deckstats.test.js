// Deck statistics (lib/deckstats.js): curve, types, pips, sources, identity.
// Rows are plain objects shaped like deckDetail's deck query (cards columns as
// lib/scryfall.js normalizeCard stores them: colours 'WU', produced_mana JSON).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deckStats, pipsOf } from "../lib/deckstats.js";

let seq = 0;
/** A resolved deck row; overrides win. */
const row = (o) => ({
  board: "main", quantity: 1, scryfall_id: `id-${++seq}`, fetched_at: "2026-10-15T00:00:00Z", layout: "normal",
  type_line: "Instant", mana_cost: "", cmc: 0, colors: "", color_identity: "", oracle_text: "", produced_mana: null,
  companion: 0, ...o,
});
const land = (name, o = {}) => row({ name, type_line: "Land", cmc: 0, mana_cost: "", ...o });
const basic = (name, c, quantity = 1) => land(name, { type_line: `Basic Land — ${name}`, produced_mana: JSON.stringify([c]), quantity });
const per = (s, c) => s.colours.per.find((p) => p.c === c);

describe("pipsOf", () => {
  test("every symbol form", () => {
    assert.deepEqual(pipsOf("{W}"), { W: 1 });
    assert.deepEqual(pipsOf("{W/U}"), { W: 0.5, U: 0.5 });
    assert.deepEqual(pipsOf("{2/W}"), { W: 1 });
    assert.deepEqual(pipsOf("{G/W/P}"), { G: 0.5, W: 0.5 });
    assert.deepEqual(pipsOf("{B/P}"), { B: 1 });
    assert.deepEqual(pipsOf("{C/W}"), { W: 1 });
    assert.deepEqual(pipsOf("{HW}"), { W: 0.5 });
    assert.deepEqual(pipsOf("{C}{C}"), { C: 2 });
    assert.deepEqual(pipsOf("{S}{S}{X}{Y}{Z}{10}"), {});
    assert.deepEqual(pipsOf("{X}{U}{U}"), { U: 2 });
    assert.deepEqual(pipsOf(null), {});
  });
});

describe("deckStats", () => {
  test("curve: creature/other split, 7+, commander separate, avg MV, types", () => {
    const s = deckStats([
      row({ board: "commander", name: "Krenko, Mob Boss", type_line: "Legendary Creature — Goblin Warrior", mana_cost: "{2}{R}{R}", cmc: 4, colors: "R", color_identity: "R" }),
      row({ name: "Goblin Guide", type_line: "Creature — Goblin Scout", mana_cost: "{R}", cmc: 1, colors: "R" }),
      row({ name: "Lightning Bolt", mana_cost: "{R}", cmc: 1, colors: "R", quantity: 2 }),
      row({ name: "Sol Ring", type_line: "Artifact", mana_cost: "{1}", cmc: 1 }),
      row({ name: "Myr Battlesphere", type_line: "Artifact Creature — Myr Construct", mana_cost: "{7}", cmc: 7 }),
      row({ name: "Blightsteel Colossus", type_line: "Artifact Creature — Phyrexian Golem", mana_cost: "{12}", cmc: 12 }),
      basic("Mountain", "R", 5),
    ]);
    assert.equal(s.total, 12);
    assert.equal(s.lands, 5);
    assert.deepEqual(s.curve.buckets, ["0", "1", "2", "3", "4", "5", "6", "7+"]);
    assert.deepEqual(s.curve.creature, [0, 1, 0, 0, 0, 0, 0, 2]);
    assert.deepEqual(s.curve.other, [0, 3, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(s.curve.commander, [{ name: "Krenko, Mob Boss", mv: 4 }]);
    // (1 + 1*2 + 1 + 7 + 12) / 6
    assert.equal(s.avg_mv, 3.83);
    assert.equal(s.types.creature, 4); // commander counts as a card of the deck
    assert.equal(s.types.artifact, 3); // artifact creatures count in both
    assert.equal(s.types.instant, 2);
    assert.equal(s.types.land, 5);
    assert.equal(s.types.battle, 0);
    assert.equal(s.colours.identity, "R");
  });

  test("MDFC flex land, transform land back, split cmc, adventure, reversible_card", () => {
    const s = deckStats([
      row({ board: "commander", name: "Niv-Mizzet, Parun", type_line: "Legendary Creature — Dragon Wizard", mana_cost: "{U}{U}{U}{R}{R}{R}", cmc: 6, colors: "UR", color_identity: "UR" }),
      row({ name: "Valakut Awakening // Valakut Stoneforge", layout: "modal_dfc", type_line: "Instant // Land", mana_cost: "{2}{R}", cmc: 3, colors: "R", produced_mana: '["R"]' }),
      row({ name: "Search for Azcanta // Azcanta, the Sunken Ruin", layout: "transform", type_line: "Legendary Enchantment // Legendary Land", mana_cost: "{1}{U}", cmc: 2, colors: "U", produced_mana: '["C","U"]' }),
      row({ name: "Fire // Ice", layout: "split", type_line: "Instant // Instant", mana_cost: "{1}{R} // {1}{U}", cmc: 4, colors: "UR" }),
      row({ name: "Bonecrusher Giant // Stomp", layout: "adventure", type_line: "Creature — Giant // Instant — Adventure", mana_cost: "{2}{R} // {1}{R}", cmc: 3, colors: "R" }),
      row({ name: "Zndrsplt // Okaun (reversible)", layout: "reversible_card", type_line: "Legendary Creature — Goblin Wizard // Legendary Creature — Goblin Wizard", mana_cost: "{2}{U} // {2}{U}", cmc: 3, colors: "U" }),
      basic("Island", "U", 2),
      basic("Mountain", "R", 2),
    ]);
    assert.equal(s.lands, 4);
    assert.equal(s.mdfc_lands, 1);
    assert.equal(s.types.land, 4); // front faces only: the MDFC is an instant
    assert.equal(s.types.instant, 2);
    assert.equal(s.types.enchantment, 1);
    assert.deepEqual(s.curve.other, [0, 0, 1, 1, 1, 0, 0, 0]); // Azcanta 2, Valakut 3, Fire // Ice 4
    assert.deepEqual(s.curve.creature, [0, 0, 0, 2, 0, 0, 0, 0]);
    // Pips: Niv 3U 3R, Valakut R, Azcanta U, Fire//Ice R+U (both halves), Bonecrusher R (front only), reversible U.
    assert.equal(per(s, "U").pips, 6);
    assert.equal(per(s, "R").pips, 6);
    // Sources: basics 2+2, Valakut half a source; the transform land back is not a source.
    assert.equal(per(s, "U").sources, 2);
    assert.equal(per(s, "R").sources, 2.5);
    assert.equal(per(s, "U").cards, 4); // Niv, Azcanta, Fire // Ice, reversible
    assert.equal(per(s, "R").cards, 4);
  });

  test("MDFC pips come from the front face only", () => {
    const s = deckStats([
      row({ name: "Agadeem's Awakening // Agadeem, the Undercrypt", layout: "modal_dfc", type_line: "Sorcery // Land", mana_cost: "{X}{B}{B}{B} // ", cmc: 3, colors: "B", produced_mana: '["B"]' }),
      row({ name: "Hybrid MDFC", layout: "modal_dfc", type_line: "Sorcery // Sorcery", mana_cost: "{G} // {W}{W}", cmc: 1, colors: "GW" }),
    ]);
    // The back face's {W}{W} never counts; W is in the identity only through `colors`.
    assert.equal(s.colours.identity, "WBG");
    assert.deepEqual(Object.fromEntries(s.colours.per.map((p) => [p.c, p.pips])), { W: 0, B: 3, G: 1 });
    assert.deepEqual(s.x_spells.names, ["Agadeem's Awakening // Agadeem, the Undercrypt"]);
    assert.equal(s.mdfc_lands, 1);
  });

  test("a missing cmc, an offline fallback row and an unresolved row are unknown, never 0-cost", () => {
    const s = deckStats([
      row({ name: "Mystery Card", type_line: "Creature — Elf", mana_cost: "{G}", cmc: null, colors: "G" }),
      row({ name: "Offline Card", type_line: "Sorcery", mana_cost: "{2}{G}", cmc: 3, fetched_at: "" }),
      row({ name: "Typo Card", scryfall_id: null, type_line: null, mana_cost: null, cmc: null, quantity: 2 }),
      row({ name: "Llanowar Elves", type_line: "Creature — Elf Druid", mana_cost: "{G}", cmc: 1, colors: "G" }),
    ]);
    assert.equal(s.total, 5);
    assert.deepEqual(s.unknown, { count: 4, names: ["Mystery Card", "Offline Card", "Typo Card"] });
    assert.deepEqual(s.curve.creature, [0, 1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(s.curve.other, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(s.avg_mv, 1);
    assert.equal(s.types.creature, 1);
    assert.equal(per(s, "G").pips, 1);
  });

  test("reversible_card without any cmc is unknown", () => {
    const s = deckStats([row({ name: "Reversible", layout: "reversible_card", type_line: "Creature — Elf", cmc: null })]);
    assert.equal(s.unknown.count, 1);
    assert.equal(s.avg_mv, null);
  });

  test("maybe, side and companion rows are excluded and only counted", () => {
    const s = deckStats([
      row({ name: "Opt", mana_cost: "{U}", cmc: 1, colors: "U" }),
      row({ name: "Counterspell", board: "maybe", mana_cost: "{U}{U}", cmc: 2, colors: "U", quantity: 2 }),
      row({ name: "Negate", board: "side", mana_cost: "{1}{U}", cmc: 2, colors: "U" }),
      row({ name: "Lurrus of the Dream-Den", board: "side", companion: 1, type_line: "Legendary Creature — Cat Nightmare", mana_cost: "{1}{W/B}{W/B}", cmc: 3, colors: "WB" }),
    ]);
    assert.equal(s.total, 1);
    assert.deepEqual(s.companion, { name: "Lurrus of the Dream-Den" });
    assert.deepEqual(s.excluded, { side: 1, maybe: 2, companion: 1 });
    assert.equal(s.colours.identity, "U");
    assert.deepEqual(s.colours.per.map((p) => [p.c, p.pips]), [["U", 1]]);
    assert.equal(s.types.creature, 0);
  });

  test("X spells stay in their bucket and are noted", () => {
    const s = deckStats([
      row({ name: "Fireball", type_line: "Sorcery", mana_cost: "{X}{R}", cmc: 1, colors: "R", quantity: 2 }),
      row({ name: "Shock", mana_cost: "{R}", cmc: 1, colors: "R" }),
    ]);
    assert.deepEqual(s.x_spells, { count: 2, names: ["Fireball"] });
    assert.equal(s.curve.other[1], 3);
  });

  test("Command Tower is clipped to the identity; NULL produced_mana falls back to the text", () => {
    const s = deckStats([
      row({ board: "commander", name: "Dimir Commander", type_line: "Legendary Creature — Horror", mana_cost: "{U}{B}", cmc: 2, colors: "UB", color_identity: "UB" }),
      land("Command Tower", { produced_mana: '["W","U","B","R","G"]' }),
      land("Old Painland", { oracle_text: "{T}: Add {C}.\n{T}: Add {U} or {B}. Old Painland deals 1 damage to you." }),
      land("Old City", { oracle_text: "{T}: Add one mana of any color." }),
      land("Old Wastes", { oracle_text: "{T}: Add {C}{C}." }),
    ]);
    assert.equal(per(s, "U").sources, 3);
    assert.equal(per(s, "B").sources, 3);
    assert.equal(s.colours.per.length, 2); // no W/R/G rows, no C row without {C} pips
  });

  test("fetchlands: basic land types map to colours, basic land card -> identity, never outside it", () => {
    const flats = land("Marsh Flats", { oracle_text: "{T}, Pay 1 life, Sacrifice Marsh Flats: Search your library for a Plains or Swamp card, put it onto the battlefield, then shuffle." });
    const wilds = land("Evolving Wilds", { oracle_text: "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle." });
    const cmd = (ci) => row({ board: "commander", name: "Cmd", type_line: "Legendary Creature — Human", mana_cost: "{1}", cmc: 1, color_identity: ci });
    const wb = deckStats([cmd("WB"), flats, wilds]);
    assert.equal(per(wb, "W").sources, 2);
    assert.equal(per(wb, "B").sources, 2);
    const wu = deckStats([cmd("WU"), flats, wilds]);
    assert.equal(per(wu, "W").sources, 2);
    assert.equal(per(wu, "U").sources, 1);
    // #081: three-type fetches (Landscapes) list their types with commas.
    const scape = land("Contaminated Landscape", { oracle_text: "{T}: Add {C}.\n{3}, {T}, Sacrifice Contaminated Landscape: Search your library for a basic Plains, Island, or Swamp card, put it onto the battlefield tapped, then shuffle." });
    const esper = deckStats([cmd("WUB"), scape]);
    for (const c of ["W", "U", "B"]) assert.equal(per(esper, c).sources, 1, c);
  });

  test("source warning when sources lag pips by more than 10 points", () => {
    const s = deckStats([
      row({ board: "commander", name: "Boros Cmd", type_line: "Legendary Creature — Human", mana_cost: "{R}{W}", cmc: 2, colors: "RW", color_identity: "RW" }),
      row({ name: "Red Spell", mana_cost: "{R}{R}{R}", cmc: 3, colors: "R", quantity: 3 }),
      basic("Plains", "W", 6),
      basic("Mountain", "R", 4),
    ]);
    // pips R 10 / W 1 -> R share .909, sources R 4/10 = .4
    assert.equal(per(s, "R").warn, true);
    assert.equal(per(s, "R").pip_share, 0.909);
    assert.equal(per(s, "R").source_share, 0.4);
    assert.equal(per(s, "W").warn, false);
  });

  test("{C} pips add a C row; colourless identity suppresses warnings", () => {
    const s = deckStats([
      row({ board: "commander", name: "Kozilek, the Great Distortion", type_line: "Legendary Creature — Eldrazi", mana_cost: "{8}{C}{C}", cmc: 10, color_identity: "" }),
      row({ name: "Thought-Knot Seer", type_line: "Creature — Eldrazi", mana_cost: "{3}{C}", cmc: 4 }),
      land("Ancient Tomb", { produced_mana: '["C"]' }),
      land("Command Tower", { produced_mana: '["W","U","B","R","G"]' }),
    ]);
    assert.equal(s.colours.identity, "");
    assert.deepEqual(s.colours.per.map((p) => [p.c, p.pips, p.sources, p.warn]), [["C", 3, 1, false]]);
    assert.equal(s.colours.colourless_cards, 2);
  });

  test("identity: partner pair and Background are the union of the commander board", () => {
    const partners = deckStats([
      row({ board: "commander", name: "Tymna the Weaver", type_line: "Legendary Creature — Human Cleric", mana_cost: "{1}{W}{B}", cmc: 3, colors: "WB", color_identity: "WB" }),
      row({ board: "commander", name: "Thrasios, Triton Hero", type_line: "Legendary Creature — Merfolk Wizard", mana_cost: "{G}{U}", cmc: 2, colors: "UG", color_identity: "UG" }),
    ]);
    assert.equal(partners.colours.identity, "WUBG");
    assert.deepEqual(partners.curve.commander.map((c) => c.mv), [3, 2]);
    assert.deepEqual(partners.curve.other, [0, 0, 0, 0, 0, 0, 0, 0]);
    const background = deckStats([
      row({ board: "commander", name: "Karlach, Fury of Avernus", type_line: "Legendary Creature — Tiefling Barbarian", mana_cost: "{4}{R}", cmc: 5, colors: "R", color_identity: "R" }),
      row({ board: "commander", name: "Guild Artisan", type_line: "Legendary Enchantment — Background", mana_cost: "{1}{W}", cmc: 2, colors: "W", color_identity: "W" }),
    ]);
    assert.equal(background.colours.identity, "WR");
    assert.equal(background.avg_mv, null);
  });

  test("identity without a commander: colours plus pip colours of the nonland cards (60-card deck)", () => {
    const s = deckStats([
      row({ name: "Kitchen Finks", type_line: "Creature — Ouphe", mana_cost: "{1}{G/W}{G/W}", cmc: 3, colors: "GW", quantity: 4 }),
      row({ name: "Gitaxian Probe", type_line: "Sorcery", mana_cost: "{U/P}", cmc: 1, colors: "U", quantity: 4 }),
      basic("Forest", "G", 12),
      basic("Plains", "W", 12),
      land("Command Tower", { produced_mana: '["W","U","B","R","G"]', quantity: 1 }),
      ...Array.from({ length: 27 }, (_, i) => row({ name: `Filler ${i}`, type_line: "Creature — Bear", mana_cost: "{1}{G}", cmc: 2, colors: "G" })),
    ]);
    assert.equal(s.total, 60);
    assert.equal(s.colours.identity, "WUG");
    assert.equal(per(s, "U").pips, 4);
    assert.equal(per(s, "U").sources, 1); // Command Tower clipped to WUG
    assert.equal(per(s, "B"), undefined);
    assert.equal(s.lands, 25);
  });

  test("opts.identity overrides the derived identity", () => {
    const s = deckStats([row({ name: "Opt", mana_cost: "{U}", cmc: 1, colors: "U" })], { identity: ["U", "R"] });
    assert.equal(s.colours.identity, "UR");
    assert.deepEqual(s.colours.per.map((p) => p.c), ["U", "R"]);
    assert.equal(deckStats([], { identity: "G" }).colours.identity, "G");
  });

  test("empty deck", () => {
    const s = deckStats([]);
    assert.equal(s.total, 0);
    assert.equal(s.avg_mv, null);
    assert.deepEqual(s.colours, { identity: "", per: [], colourless_cards: 0 });
    assert.equal(s.companion, null);
  });
});
