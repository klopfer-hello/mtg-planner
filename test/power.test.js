// Deck power (lib/power.js): commander detection, legality, bracket floors and
// the 1-10 score. Rows are plain objects shaped like deckDetail's deck query;
// card texts come from the recorded Scryfall fixture (cards-classify.json) where
// it has the card, else they are written out here. Spellbook results are
// trimResult-shaped objects (the recorded response is used once, end to end).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BRACKET_RULES, SCORE_BANDS, WEIGHTS, bracketOf, isCommanderDeck, legality, powerOf, scoreOf,
} from "../lib/power.js";
import { trimResult } from "../lib/spellbook.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/cards-classify.json", import.meta.url), "utf8"));
const BY_NAME = new Map(FIXTURE.cards.map((c) => [c.name, c]));
const SB_FULL = JSON.parse(readFileSync(new URL("./fixtures/spellbook-estimate-full.json", import.meta.url), "utf8"));

let seq = 0;
/** A resolved deck row (fixture card when known); overrides win. */
function card(name, o = {}) {
  const f = BY_NAME.get(name) ?? {};
  const { otags, commander_legal: _l, ...rest } = f;
  return {
    board: "main", quantity: 1, companion: 0, layout: "normal", mana_cost: "", colors: "", color_identity: "",
    legalities: JSON.stringify({ commander: "legal" }), fetched_at: "2026-10-15T00:00:00Z", produced_mana: null,
    type_line: "Creature — Bear", cmc: 3, oracle_text: "", keywords: "[]", game_changer: 0,
    ...rest, name, scryfall_id: `id-${++seq}`, ...o,
  };
}
const unresolved = (name, o = {}) => ({ board: "main", quantity: 1, companion: 0, name, scryfall_id: null, ...o });
const commander = (name = "Mono White Leader", o = {}) => card(name, {
  board: "commander", type_line: "Legendary Creature — Human", cmc: 3, mana_cost: "{2}{W}", colors: "W", color_identity: "W", ...o,
});
const plains = (n) => card("Plains", { type_line: "Basic Land — Plains", cmc: 0, produced_mana: '["W"]', quantity: n });
const filler = (i, o = {}) => card(`Filler Bear ${i}`, { mana_cost: "{2}{W}", colors: "W", color_identity: "W", ...o });

/**
 * A legal 100-card mono-white commander deck: commander + `extra` + vanilla
 * fillers + Plains (36 lands unless the extra cards bring lands).
 */
function deck(extra = [], { lands = 36, cmd = [commander()] } = {}) {
  const used = cmd.reduce((s, r) => s + r.quantity, 0) + extra.reduce((s, r) => s + (r.quantity ?? 1), 0);
  const fill = 100 - used - lands;
  assert.ok(fill >= 0, "deck too big");
  return [...cmd, ...extra, ...Array.from({ length: fill }, (_, i) => filler(i)), plains(lands)];
}
const CMD = { format: "commander" };
const combo = (o) => ({
  id: `c-${++seq}`, cards: ["Piece A", "Piece B"], produces: ["Win the game"], manaValueNeeded: 4, speed: 4,
  definitelyTwoCard: true, arguablyTwoCard: true, relevant: true, borderlineRelevant: true, lock: false, extraTurn: false,
  massLandDenial: false, skipTurns: false, controlAllOpponents: false, controlSomeOpponents: false, ...o,
});
/** A checked (status ok) cachedCombos view. */
const checked = (o = {}) => ({
  status: "ok", fetched_at: "2026-10-15T10:00:00.000Z",
  result: { parser: 1, tag: null, gc: [], mld: [], extra_turns: [], banned: [], combos: [], combos_total: 0, unresolved: [], ...o },
});
const rules = (b) => b.reasons.map((r) => r.rule);

describe("isCommanderDeck", () => {
  test("format commander / EDH / cEDH, any case", () => {
    for (const format of ["commander", "Commander ", "EDH", "cedh"]) assert.equal(isCommanderDeck({ format }, []), true, format);
    assert.equal(isCommanderDeck({ format: "modern" }, deck()), false);
    assert.equal(isCommanderDeck({ format: "brawl" }, deck()), false);
  });
  test("NULL format: a commander board or 98-101 cards", () => {
    assert.equal(isCommanderDeck({ format: null }, [commander(), filler(1)]), true);
    const main99 = Array.from({ length: 99 }, (_, i) => filler(i));
    assert.equal(isCommanderDeck({ format: "" }, main99), true);
    assert.equal(isCommanderDeck({ format: null }, main99.slice(0, 60)), false);
    // a companion is not part of the 99 and a 60-card list with a sideboard stays out
    assert.equal(isCommanderDeck({ format: null }, [...main99.slice(0, 97), card("Lurrus", { board: "side", companion: 1 })]), false);
  });
  test("a NULL-format ManaBox deck with a commander board gets a bracket; a 60-card deck stats only", () => {
    const p = powerOf({ format: null, source: "manabox" }, deck(), { combos: checked() });
    assert.equal(p.commander, true);
    assert.equal(p.bracket.value, 2);
    assert.equal(typeof p.score.value, "number");
    const sixty = [...Array.from({ length: 36 }, (_, i) => filler(i)), plains(24)];
    const q = powerOf({ format: null }, sixty, { combos: checked() });
    assert.deepEqual([q.commander, q.bracket, q.score, q.legality], [false, null, null, null]);
    assert.equal(q.stats.total, 60);
    assert.equal(bracketOf({ format: "standard" }, sixty), null);
    assert.equal(scoreOf({ format: "standard" }, sixty), null);
  });
});

describe("bracketOf: floors", () => {
  test("nothing special: 2, never 1 on its own, not partial with combos checked", () => {
    const b = bracketOf(CMD, deck(), { combos: checked() });
    assert.equal(b.auto, 2);
    assert.equal(b.value, 2);
    assert.equal(b.label, "Core");
    assert.equal(b.meaning, "games usually last 8+ turns");
    assert.equal(b.partial, false);
    assert.equal(b.display, "2");
    assert.deepEqual(rules(b), ["base"]);
    assert.match(b.reasons[0].text, /Bracket 1 is about intent/);
    assert.equal(b.legality.ok, true, JSON.stringify(b.legality));
  });

  test("Game Changers: 1-3 → 3 naming the cards, 4+ → 4; Scryfall flag 0 beats the list", () => {
    const two = bracketOf(CMD, deck([card("Rhystic Study"), card("Smothering Tithe")]), { combos: checked() });
    assert.equal(two.auto, 3);
    assert.equal(two.reasons[0].rule, "game_changers");
    assert.match(two.reasons[0].text, /^2 Game Changers: Rhystic Study, Smothering Tithe\. Bracket 3 allows up to 3$/);
    assert.equal(two.reasons[0].source, "scryfall");
    assert.deepEqual(two.reasons[0].cards.map((c) => c.why), ["gc_flag", "gc_flag"]);
    const four = bracketOf(CMD, deck(["Rhystic Study", "Smothering Tithe", "Cyclonic Rift", "Demonic Tutor"].map((n) => card(n))), { combos: checked() });
    assert.equal(four.auto, 4);
    assert.match(four.reasons[0].text, /^4 Game Changers/);
    // game_changer 0 (Scryfall says no, e.g. after a list change) wins over the fallback list
    const off = bracketOf(CMD, deck([card("Rhystic Study", { game_changer: 0 })]), { combos: checked() });
    assert.equal(off.auto, 2);
  });

  test("Game Changer flag unknown → partial unless the list or Spellbook knows the card", () => {
    const rows = deck([card("Mystery Card", { game_changer: null })]);
    const b = bracketOf(CMD, rows, { combos: checked({ unresolved: ["Mystery Card"] }) });
    assert.equal(b.partial, true);
    assert.equal(b.display, "≥2");
    assert.ok(b.reasons.some((r) => /1 card: Game Changer flag not fetched yet/.test(r.text)));
    // Spellbook saw the card and did not flag it: known
    assert.equal(bracketOf(CMD, rows, { combos: checked() }).partial, false);
    // NULL flag but on GC_FALLBACK: counts, source list
    const listed = bracketOf(CMD, deck([card("Rhystic Study", { game_changer: null })]), { combos: checked({ unresolved: ["Rhystic Study"] }) });
    assert.equal(listed.auto, 3);
    assert.equal(listed.partial, false);
    assert.equal(listed.reasons[0].source, "list");
  });

  test("Spellbook's per-card flags are merged (source spellbook)", () => {
    const b = bracketOf(CMD, deck([card("Plain Card", { game_changer: null })]), { combos: checked({ gc: ["Plain Card"] }) });
    assert.equal(b.auto, 3);
    assert.equal(b.reasons[0].cards[0].source, "spellbook");
  });

  test("mass land denial → 4 quoting the official definition; single land destruction does not count", () => {
    const b = bracketOf(CMD, deck([card("Armageddon")]), { combos: checked() });
    assert.equal(b.auto, 4);
    assert.equal(b.reasons[0].rule, "mld");
    assert.match(b.reasons[0].text, /Armageddon .*four or more lands per player/);
    const ld = card("Stone Rain", { type_line: "Sorcery", oracle_text: "Destroy target land." });
    assert.equal(bracketOf(CMD, deck([ld]), { combos: checked() }).auto, 2);
  });

  test("extra turns: 1-2 cards info only, 3+ → 3 (chaining heuristic)", () => {
    const turn = (n) => card(`Turn Spell ${n}`, { type_line: "Sorcery", cmc: 5, oracle_text: "Take an extra turn after this one." });
    const two = bracketOf(CMD, deck([turn(1), turn(2)]), { combos: checked() });
    assert.equal(two.auto, 2);
    assert.ok(two.info.some((l) => /^2 extra-turn cards .*fine in Bracket 2/.test(l)));
    const three = bracketOf(CMD, deck([turn(1), turn(2), turn(3)]), { combos: checked() });
    assert.equal(three.auto, 3);
    assert.equal(three.reasons[0].rule, "extra_turns");
    assert.match(three.reasons[0].text, /Chaining likely \(heuristic\)/);
    // "skip … extra turn" texts are no extra-turn cards
    const skip = card("Skip Turn", { type_line: "Sorcery", oracle_text: "Target player skips their next turn. You take an extra turn after this one." });
    assert.equal(bracketOf(CMD, deck([turn(1), turn(2), skip]), { combos: checked() }).auto, 3);
  });

  test("tutors never set a floor (info line only)", () => {
    const tutors = Array.from({ length: 8 }, (_, i) => card(`Tutor ${i}`, {
      type_line: "Sorcery", cmc: 2, oracle_text: "Search your library for a card, put that card into your hand, then shuffle.", game_changer: 0,
    }));
    const b = bracketOf(CMD, deck(tutors), { combos: checked() });
    assert.equal(b.auto, 2);
    assert.ok(b.info.includes("8 tutors, not a bracket rule since 21 Oct 2025"));
  });
});

describe("bracketOf: combos (manaValueNeeded is the only speed signal)", () => {
  const at = (c) => bracketOf(CMD, deck(), { combos: checked({ combos: [combo(c)], combos_total: 1 }) });
  test("definitely two-card at ≤4 mana → 4; 5 mana with Spellbook speed 4 → 3", () => {
    const fast = at({ manaValueNeeded: 4 });
    assert.equal(fast.auto, 4);
    assert.match(fast.reasons[0].text, /^2-card combo Piece A \+ Piece B, ≤4 mana \(4 mana\): can end games before turn 6 \(heuristic\)$/);
    assert.equal(fast.reasons[0].source, "spellbook");
    assert.match(fast.reasons[0].url, /^https:\/\/commanderspellbook\.com\/combo\/c-\d+\/$/);
    const late = at({ manaValueNeeded: 5, speed: 4 });
    assert.equal(late.auto, 3);
    assert.match(late.reasons[0].text, /^late 2-card combo .*\(5 mana\)$/);
  });
  test("two-card lock: ≤4 → 4, >4 → 3; a 4-card lock → info only; controlAllOpponents → 4", () => {
    const lock = { produces: ["Lock"], lock: true };
    assert.equal(at({ ...lock, manaValueNeeded: 3 }).auto, 4);
    assert.equal(at({ ...lock, manaValueNeeded: 6 }).auto, 3);
    const four = at({ ...lock, cards: ["A", "B", "C", "D"], definitelyTwoCard: false, arguablyTwoCard: false, manaValueNeeded: 3 });
    assert.equal(four.auto, 2);
    assert.ok(four.info.includes("1 combo of 3+ cards (not a bracket rule)"));
    assert.equal(at({ produces: ["Control all opponents"], controlAllOpponents: true, manaValueNeeded: 9 }).auto, 4);
  });
  test("arguably two-card → 3 (borderline), irrelevant or harmless combos ignored", () => {
    const arg = at({ definitelyTwoCard: false, arguablyTwoCard: true, manaValueNeeded: 2 });
    assert.equal(arg.auto, 3);
    assert.equal(arg.reasons[0].borderline, true);
    assert.match(arg.reasons[0].text, /borderline/);
    assert.equal(at({ relevant: false, borderlineRelevant: false }).auto, 2);
    assert.equal(at({ produces: ["Create a 1/1 token"] }).auto, 2);
  });
  test("extra-turn combo: fast → 4, slow → 3", () => {
    const fast = at({ produces: ["Infinite turns"], extraTurn: true, manaValueNeeded: 4 });
    assert.equal(fast.auto, 4);
    assert.equal(fast.reasons[0].rule, "extra_turn_combo");
    assert.match(fast.reasons[0].text, /^2-card extra-turn combo/);
    assert.equal(at({ produces: ["Infinite turns"], extraTurn: true, manaValueNeeded: 7 }).auto, 3);
  });
});

describe("bracketOf: combo assembly cost (manaValueNeeded + battlefield pieces)", () => {
  test("Vito + Exquisite Blood (on the battlefield, 3 + 5) → late combo, 3; Thoracle + Consultation (from hand, 3) → 4", () => {
    const vito = commander("Vito, Thorn of the Dusk Rose", { cmc: 3, mana_cost: "{2}{B}", colors: "B", color_identity: "B" });
    const blood = card("Exquisite Blood", { cmc: 5, mana_cost: "{4}{B}", color_identity: "B", type_line: "Enchantment" });
    const rows = deck([blood], { cmd: [vito] });
    const vb = combo({ cards: ["Vito, Thorn of the Dusk Rose", "Exquisite Blood"], battlefield: ["Vito, Thorn of the Dusk Rose", "Exquisite Blood"],
      manaValueNeeded: 0, produces: ["Infinite lifeloss"] });
    const b = bracketOf(CMD, rows, { combos: checked({ combos: [vb], combos_total: 1 }) });
    assert.equal(b.auto, 3);
    assert.ok(b.reasons.some((r) => r.text === "late 2-card combo Vito, Thorn of the Dusk Rose + Exquisite Blood (8 mana)"), JSON.stringify(b.reasons));
    const s8 = scoreOf(CMD, rows, { combos: checked({ combos: [vb] }), bracket: b }).breakdown.find((x) => x.key === "combos");
    assert.equal(s8.points, WEIGHTS.combos.fast, "8 mana to assemble: fast for the score (≤ fast_mv), late for the bracket");

    const thor = card("Thassa's Oracle", { cmc: 2 });
    const cons = card("Demonic Consultation", { cmc: 1 });
    const tc = combo({ cards: ["Thassa's Oracle", "Demonic Consultation"], battlefield: [], manaValueNeeded: 3 });
    const fast = bracketOf(CMD, deck([thor, cons]), { combos: checked({ combos: [tc], combos_total: 1 }) });
    assert.equal(fast.auto, 4);
    assert.ok(fast.reasons.some((r) => r.text.includes("≤4 mana (3 mana)")));
  });

  test("a battlefield piece without a known mana value → mana unknown: floor 3, mid weight", () => {
    const c = combo({ cards: ["Piece A", "Piece B"], battlefield: ["Piece A"], manaValueNeeded: 0 });
    const rows = deck();
    const b = bracketOf(CMD, rows, { combos: checked({ combos: [c], combos_total: 1 }) });
    assert.equal(b.auto, 3);
    assert.ok(b.reasons.some((r) => r.text.includes("mana unknown")));
    const sc = scoreOf(CMD, rows, { combos: checked({ combos: [c] }), bracket: b }).breakdown.find((x) => x.key === "combos");
    assert.equal(sc.points, WEIGHTS.combos.mid);
  });
});

describe("bracketOf: declared, partial, Spellbook, cEDH", () => {
  test("declared below the rules warns; B1/B5 only when declared", () => {
    const rows = deck([card("Armageddon")]);
    const b = bracketOf({ ...CMD, bracket_declared: 2 }, rows, { combos: checked() });
    assert.equal(b.value, 2);
    assert.equal(b.auto, 4);
    assert.equal(b.declared, 2);
    assert.equal(b.display, "2");
    assert.equal(b.reasons[0].rule, "declared_below");
    assert.equal(b.reasons[0].level, "warn");
    assert.match(b.reasons[0].text, /^You set 2, but the rules point to ≥4: Mass land denial: Armageddon/);
    const five = bracketOf({ ...CMD, bracket_declared: 5 }, rows, { combos: checked() });
    assert.equal(five.value, 5);
    assert.equal(five.label, "cEDH");
    assert.ok(!rules(five).includes("declared_below"));
    const one = bracketOf({ ...CMD, bracket_declared: 1 }, deck(), { combos: checked() });
    assert.equal(one.value, 1);
    assert.equal(one.label, "Exhibition");
    assert.ok(!rules(one).includes("declared_below"), "B1 below the base 2 is intent, no warning");
    // opts.declared overrides, invalid values mean auto
    assert.equal(bracketOf(CMD, rows, { combos: checked(), declared: 3 }).value, 3);
    assert.equal(bracketOf({ ...CMD, bracket_declared: 7 }, rows, { combos: checked() }).declared, null);
    // auto never reaches 5
    const huge = deck(["Rhystic Study", "Smothering Tithe", "Cyclonic Rift", "Demonic Tutor", "Armageddon"].map((n) => card(n)));
    assert.equal(bracketOf(CMD, huge, { combos: checked({ combos: [combo({ manaValueNeeded: 1 })] }) }).auto, BRACKET_RULES.auto_max);
  });

  test("combos unchecked → partial '≥' with the reason; stale results are used with their date", () => {
    for (const [status, why] of [["pending", "pending"], ["offline", "offline"], ["disabled", "combo check is off"]]) {
      const b = bracketOf(CMD, deck(), { combos: { status, fetched_at: null, result: null } });
      assert.equal(b.partial, true, status);
      assert.equal(b.display, "≥2");
      assert.ok(b.reasons.some((r) => r.text === `combos not checked (${why})`), status);
    }
    assert.equal(bracketOf(CMD, deck()).partial, true, "no combos view at all");
    const stale = bracketOf(CMD, deck(), { combos: { ...checked({ combos: [combo({ manaValueNeeded: 3 })] }), status: "stale", fetched_at: "2026-09-01T00:00:00Z" } });
    assert.equal(stale.partial, false);
    assert.equal(stale.auto, 4);
    assert.ok(stale.info.includes("combos from 2026-09-01"));
  });

  test("Spellbook's tag is a second opinion and never raises ours", () => {
    const b = bracketOf(CMD, deck(), { combos: checked({ tag: "R" }) });
    assert.equal(b.value, 2);
    assert.ok(b.info.includes("Commander Spellbook rates it Ruthless (≈4)"));
    assert.deepEqual([b.spellbook.tag, b.spellbook.bracket, b.spellbook.status], ["R", 4, "ok"]);
    const lower = bracketOf(CMD, deck([card("Armageddon")]), { combos: checked({ tag: "C" }) });
    assert.ok(!lower.info.some((l) => /rates it/.test(l)));
    assert.equal(bracketOf(CMD, deck(), { combos: checked({ tag: null }) }).spellbook.bracket, null);
  });

  test("unresolved rows: a Game Changer name counts via GC_FALLBACK; an unknown name → partial", () => {
    const gc = bracketOf(CMD, deck([unresolved("Rhystic Study")]), { combos: checked({ unresolved: ["Rhystic Study"] }) });
    assert.equal(gc.auto, 3);
    assert.equal(gc.reasons[0].cards[0].source, "name");
    const unknown = bracketOf(CMD, deck([unresolved("Homebrew Thing")]), { combos: checked({ unresolved: ["Homebrew Thing"] }) });
    assert.equal(unknown.partial, true);
    assert.ok(unknown.reasons.some((r) => r.text === "1 card not identified: Homebrew Thing"));
    assert.ok(unknown.info.includes("1 card not checked by Commander Spellbook"));
    // Spellbook recognised the typed name: identified
    assert.equal(bracketOf(CMD, deck([unresolved("Some Real Card")]), { combos: checked() }).partial, false);
  });

  test("cEDH hint: auto 4 + fast mana ≥5 + cheap tutors + a fast combo + low curve", () => {
    const fast = ["Sol Ring", "Mana Crypt", "Mana Vault", "Chrome Mox", "Mox Diamond", "Lotus Petal"].map((n) => card(n));
    const tutors = ["Demonic Tutor", "Vampiric Tutor", "Mystical Tutor"].map((n) => card(n));
    const cheap = Array.from({ length: 50 }, (_, i) => filler(`c${i}`, { cmc: 1, mana_cost: "{W}" }));
    const rows = deck([...fast, ...tutors, ...cheap], { lands: 30 });
    const combos = checked({ combos: [combo({ manaValueNeeded: 2 })] });
    const b = bracketOf(CMD, rows, { combos });
    assert.equal(b.auto, 4);
    assert.equal(b.cedh_hint, true);
    assert.ok(b.info.includes("Looks cEDH-like; set 5 if that is the intent"));
    assert.equal(b.value, 4, "the hint never sets 5");
    assert.equal(bracketOf({ ...CMD, bracket_declared: 5 }, rows, { combos }).cedh_hint, false);
    assert.equal(bracketOf({ ...CMD, bracket_declared: 5 }, rows, { combos }).cedh_like, true, "the raw test ignores the declared 5");
    // a slow curve is no cEDH
    const slow = deck([...fast, ...tutors], { lands: 36 });
    assert.equal(bracketOf(CMD, slow, { combos }).cedh_hint, false);
  });

  test("recorded Spellbook response end to end (names only, unresolved rows)", () => {
    const body = SB_FULL.request.body;
    const result = trimResult(SB_FULL.response, [...body.commanders, ...body.main].map((e) => e.card));
    const rows = [
      ...body.commanders.map((e) => unresolved(e.card, { board: "commander" })),
      ...body.main.map((e) => unresolved(e.card)),
    ];
    const b = bracketOf({ format: null }, rows, { combos: { status: "ok", fetched_at: "2026-10-15T00:00:00Z", result } });
    assert.equal(b.auto, 4);
    const byRule = (rule) => b.reasons.filter((r) => r.rule === rule);
    assert.deepEqual(byRule("mld")[0].cards.map((c) => c.name), ["Armageddon"]);
    assert.ok(byRule("combo").some((r) => r.floor === 4 && /Demonic Consultation \+ Thassa's Oracle/.test(r.text)));
    assert.ok(byRule("combo").some((r) => r.floor === 3 && r.borderline && /Isochron Scepter/.test(r.text)));
    assert.match(byRule("game_changers")[0].text, /^2 Game Changers: Thassa's Oracle, Rhystic Study/);
    assert.ok(b.info.some((l) => /^1 extra-turn card \(Time Warp\)/.test(l)));
    assert.ok(b.reasons.some((r) => r.text === "1 card not identified: Notacard Xyz"));
    assert.ok(!b.info.some((l) => /rates it/.test(l)), "R (4) is not above our 4");
  });
});

describe("legality", () => {
  const problems = (rows, deckRow = CMD, opts) => legality(deckRow, rows, opts).problems.map((p) => p.rule);
  test("an unresolved commander: colour identity not checked (no 'outside' flood), stats fall back to the cards", () => {
    const rows = [unresolved("Some Typo Commander", { board: "commander" }),
      ...Array.from({ length: 60 }, (_, i) => card(`Filler ${i}`, { color_identity: "B", colors: "B", mana_cost: "{2}{B}" })),
      card("Swamp", { type_line: "Basic Land — Swamp", cmc: 0, produced_mana: '["B"]', quantity: 39 })];
    const l = legality(CMD, rows);
    assert.ok(!l.problems.some((p) => p.rule === "identity"), JSON.stringify(l.problems));
    assert.ok(l.notes.includes("Commander not identified: colour identity not checked"));
    assert.equal(l.ok, true);
    assert.equal(powerOf(CMD, rows).stats.colours.identity, "B");
  });

  test("unresolved rows are not singleton problems (they are 'not checked')", () => {
    const rows = deck([unresolved("Relentless Ratz", { quantity: 30 })], { lands: 6 });
    const l = legality(CMD, rows);
    assert.ok(!l.problems.some((p) => p.rule === "singleton"), JSON.stringify(l.problems));
    assert.equal(l.unchecked, 30);
  });

  test("a clean deck is legal", () => {
    assert.deepEqual(legality(CMD, deck()), { ok: true, problems: [], unchecked: 0, notes: [] });
  });
  test("banned, not legal and Spellbook's banned list", () => {
    const banned = card("Banned Thing", { legalities: JSON.stringify({ commander: "banned" }) });
    const un = card("Silver Border", { legalities: JSON.stringify({ commander: "not_legal" }) });
    const l = legality(CMD, deck([banned, un]));
    assert.deepEqual(l.problems.map((p) => p.rule), ["banned", "not_legal"]);
    assert.match(l.problems[0].text, /^Banned in Commander: Banned Thing \(only OK in Bracket 1 by agreement\)$/);
    assert.deepEqual(problems(deck([card("Odd One")]), CMD, { combos: checked({ banned: ["Odd One"] }) }), ["banned"]);
  });
  test("colour identity outside the commanders' union (partners join)", () => {
    const blue = card("Blue Card", { color_identity: "U", colors: "U" });
    const l = legality(CMD, deck([blue]));
    assert.deepEqual(l.problems.map((p) => p.rule), ["identity"]);
    assert.match(l.problems[0].text, /Outside the commander's colours \(W\): Blue Card/);
    const partners = [
      commander("Partner W", { oracle_text: "Partner" }),
      commander("Partner U", { oracle_text: "Partner", colors: "U", color_identity: "U", mana_cost: "{2}{U}" }),
    ];
    assert.deepEqual(problems(deck([blue], { cmd: partners })), []);
  });
  test("singleton: duplicates flagged, basics and 'any number' / 'up to seven' cards allowed", () => {
    const sol = card("Sol Ring", { quantity: 2 });
    assert.deepEqual(problems(deck([sol])), ["singleton"]);
    const rats = card("Relentless Rats", { quantity: 20, oracle_text: "Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\nA deck can have any number of cards named Relentless Rats." });
    assert.deepEqual(problems(deck([rats])), []);
    const dwarf = (n) => card("Seven Dwarves", { quantity: n, oracle_text: "A deck can have up to seven cards named Seven Dwarves." });
    assert.deepEqual(problems(deck([dwarf(7)])), []);
    assert.deepEqual(problems(deck([dwarf(8)])), ["singleton"]);
  });
  test("size ≠ 100 and commander pairing", () => {
    const rows = deck();
    rows.pop();
    rows.push(plains(35));
    assert.deepEqual(problems(rows), ["size"]);
    assert.match(legality(CMD, rows).problems[0].text, /^99 cards with the commander, not 100/);
    const unpaired = [commander("Leader A"), commander("Leader B")];
    const l = legality(CMD, deck([], { cmd: unpaired }));
    assert.deepEqual(l.problems.map((p) => p.rule), ["commanders"]);
    assert.match(l.problems[0].text, /Leader A and Leader B cannot be commanders together/);
    const bg = [commander("Choosy", { oracle_text: "Choose a Background" }), commander("Some Background", { type_line: "Legendary Enchantment — Background" })];
    assert.deepEqual(problems(deck([], { cmd: bg })), []);
    const three = [commander("A", { oracle_text: "Partner" }), commander("B", { oracle_text: "Partner" }), commander("C", { oracle_text: "Partner" })];
    assert.deepEqual(problems(deck([], { cmd: three })), ["commanders"]);
  });
  test("unknown rows are not checked, only counted", () => {
    const off = card("Offline Blue", { fetched_at: "", color_identity: "U" });
    const l = legality(CMD, deck([off, unresolved("Who Knows")]));
    assert.equal(l.ok, true);
    assert.equal(l.unchecked, 2);
    assert.deepEqual(l.notes, ["2 cards not checked (card data missing)"]);
  });
  test("legality problems are a bad reason, never a bracket number", () => {
    const b = bracketOf(CMD, deck([card("Sol Ring", { quantity: 2 })]), { combos: checked() });
    assert.equal(b.auto, 2);
    const r = b.reasons.find((x) => x.rule === "legality");
    assert.equal(r.level, "bad");
    assert.match(r.text, /^Not Commander-legal: More than one copy: 2x Sol Ring \(only OK in Bracket 1 by agreement\)$/);
  });
});

describe("scoreOf", () => {
  const cat = (s, key) => s.breakdown.find((b) => b.key === key);
  test("a vanilla deck: speed from the curve, mana base bonus, nothing else", () => {
    const s = scoreOf(CMD, deck(), { combos: checked() });
    // avg MV 3 → 0.45; mono-W, sources match pips → +0.2; no nonbasics
    assert.equal(cat(s, "speed").points, 0.45);
    assert.equal(cat(s, "mana_base").points, 0.2);
    assert.equal(s.value, 1.7);
    assert.equal(s.half, 1.5);
    assert.equal(s.partial, false);
    assert.equal(s.display, "1.7");
    assert.deepEqual(s.breakdown.map((b) => b.key), ["speed", "fast_mana", "tutors", "combos", "interaction", "draw", "ramp", "mana_base"]);
    assert.equal(Object.values(WEIGHTS).reduce((sum, w) => sum + w.max, 0), 9);
  });

  test("per-card weights, Sol Ring 0.2, caps, bars and top cards", () => {
    const rows = deck([
      card("Sol Ring"), card("Mana Crypt"), card("Mana Vault"),
      card("Demonic Tutor"), card("Vampiric Tutor"),
      card("Swords to Plowshares"), card("Counterspell"), card("Wrath of God"),
      card("Rhystic Study"), card("Brainstorm"), card("Cultivate"),
    ]);
    const s = scoreOf(CMD, rows, { combos: checked() });
    assert.equal(cat(s, "fast_mana").points, 1.3); // 0.55 + 0.55 + 0.2
    assert.deepEqual(cat(s, "fast_mana").cards, ["Mana Crypt", "Mana Vault", "Sol Ring"]);
    assert.equal(cat(s, "tutors").points, 0.8);
    assert.equal(cat(s, "tutors").bar, 8);
    assert.equal(cat(s, "interaction").points, 0.3); // 0.08 + 0.1 + 0.12
    assert.equal(cat(s, "draw").points, 0.23); // engine 0.18 + burst 0.05 (Brainstorm draws three)
    assert.equal(cat(s, "ramp").points, 0.06);
    assert.equal(cat(s, "ramp").words, "ramp 1 of ~10");
    // caps: 10 fast mana rocks still give at most 1.75
    const many = Array.from({ length: 10 }, (_, i) => card(`Rock ${i}`, { type_line: "Artifact", cmc: 0, oracle_text: "{T}: Add {C}{C}.", produced_mana: '["C"]' }));
    const capped = cat(scoreOf(CMD, deck(many), { combos: checked() }), "fast_mana");
    assert.equal(capped.points, 1.75);
    assert.equal(capped.bar, 10);
    assert.equal(capped.count, 10);
    assert.equal(capped.cards.length, 5);
  });

  test("combos: by assembly cost (fast ≤ 8, slow ≥ 12), best ×1, second ×0.5, rest ×0.25; unchecked → 0 and '≥'", () => {
    const combos = checked({ combos: [
      combo({ manaValueNeeded: 3 }), combo({ manaValueNeeded: 12 }),
      combo({ cards: ["A", "B", "C"], definitelyTwoCard: false, arguablyTwoCard: false }),
    ] });
    const s = scoreOf(CMD, deck(), { combos });
    assert.equal(cat(s, "combos").points, 1.8); // 1.5 + 0.4·0.5 + 0.4·0.25
    assert.equal(cat(s, "combos").words, "2 two-card, 1 longer");
    const off = scoreOf(CMD, deck(), { combos: { status: "offline", result: null } });
    assert.equal(cat(off, "combos").points, 0);
    assert.equal(off.partial, true);
    assert.match(off.display, /^≥ /);
    assert.ok(s.value > off.value, "going online can only add");
  });

  test("speed: piecewise curve and the top-heavy penalty", () => {
    const cheap = deck(Array.from({ length: 63 }, (_, i) => filler(`x${i}`, { cmc: 2 })));
    assert.equal(cat(scoreOf(CMD, cheap, { combos: checked() }), "speed").points, 1);
    const heavy = Array.from({ length: 13 }, (_, i) => filler(`h${i}`, { cmc: 7 }));
    const sp = cat(scoreOf(CMD, deck(heavy), { combos: checked() }), "speed");
    assert.equal(sp.note, "13 cards cost 6+");
    assert.ok(sp.points < 0.2);
  });

  test("mana base: fixing share (tapped lands half), short mana base penalty", () => {
    const cmd = [commander("Azorius Leader", { color_identity: "WU", colors: "WU", mana_cost: "{1}{W}{U}" })];
    const dual = (n, o = {}) => card(`Dual ${n}`, { type_line: "Land", cmc: 0, produced_mana: '["W","U"]', ...o });
    const islands = card("Island", { type_line: "Basic Land — Island", cmc: 0, produced_mana: '["U"]', quantity: 16 });
    const rows = deck([dual(1), dual(2, { oracle_text: "This land enters tapped." }), card("Utility Land", { type_line: "Land", cmc: 0, produced_mana: '["C"]' }), islands], { lands: 17, cmd });
    const s = scoreOf(CMD, rows, { combos: checked() });
    const m = cat(s, "mana_base");
    assert.equal(m.words.startsWith("50% of 3 nonbasic lands fix"), true, m.words); // (1 + 0.5) / 3
    assert.ok(m.points >= 0.15 && m.points <= 0.35, String(m.points));
    const short = scoreOf(CMD, deck([], { lands: 28 }), { combos: checked() });
    assert.equal(cat(short, "mana_base").note, "only 28 lands and 0 ramp");
    assert.equal(cat(short, "mana_base").points, 0); // 0.2 − 0.2
  });

  test("unknown cards add nothing; the band note names the top category", () => {
    const s = scoreOf(CMD, deck([unresolved("Sol Ring"), card("Mana Crypt", { fetched_at: "" })]), { combos: checked() });
    assert.equal(cat(s, "fast_mana").points, 0);
    assert.equal(s.unknown, 2);
    const fast = ["Sol Ring", "Mana Crypt", "Mana Vault", "Chrome Mox", "Mox Diamond", "Lotus Petal"].map((n) => card(n));
    const rows = deck([...fast, ...Array.from({ length: 50 }, (_, i) => filler(`c${i}`, { cmc: 1 }))], { lands: 30 });
    const combos = checked({ combos: [combo({ manaValueNeeded: 2 }), combo({ manaValueNeeded: 3 })] });
    const declared2 = scoreOf(CMD, rows, { combos, bracket: { value: 2 } });
    assert.deepEqual(declared2.band, { bracket: 2, low: SCORE_BANDS[2][0], high: SCORE_BANDS[2][1] });
    assert.ok(declared2.value > 4.5, String(declared2.value));
    assert.equal(declared2.note, "Score is high for Bracket 2 because of combos");
    const low = scoreOf(CMD, deck(), { combos: checked(), bracket: { value: 4 } });
    assert.equal(low.note, "Score is low for Bracket 4: little fast mana");
    // partial scores get no "low" note (combos may add)
    assert.equal(scoreOf(CMD, deck(), { combos: null, bracket: { value: 4 } }).note, null);
  });

  test("powerOf ties it together", () => {
    const p = powerOf(CMD, deck([card("Rhystic Study")]), { combos: checked() });
    assert.equal(p.bracket.value, 3);
    assert.deepEqual(p.score.band, { bracket: 3, low: 4.5, high: 7.5 });
    assert.equal(p.legality, p.bracket.legality);
    assert.equal(p.stats.total, 100);
  });
});
