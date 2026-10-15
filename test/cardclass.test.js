// lib/cardclass.js: per-tag positives and tricky negatives on real oracle
// texts, the curated lists, the memo, and precision/recall against Scryfall
// Tagger on a recorded fixture (test/fixtures/cards-classify.json, recorded
// 2026-10-15 from the Scryfall API: card fields + otag memberships, f:commander).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCard, classifyByName, mergeSpellbook, clearClassifyMemo, hasTag, tagOf, isLand, textOf, normName,
  GC_FALLBACK, FAST_MANA, MLD_LIST, FREE_INTERACTION_EXTRA, CARD_TAGS,
} from "../lib/cardclass.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/cards-classify.json", import.meta.url), "utf8"));
const BY_NAME = new Map(FIXTURE.cards.map((c) => [c.name, c]));
const card = (name) => {
  const c = BY_NAME.get(name);
  assert.ok(c, `fixture has ${name}`);
  return c;
};
const tags = (name) => classifyCard(card(name)).map((t) => t.tag);
const has = (name, tag) => hasTag(classifyCard(card(name)), tag);

function expectTags(tag, yes, no) {
  for (const n of yes) assert.ok(has(n, tag), `${n} should be ${tag} (got ${tags(n).join(",") || "none"})`);
  for (const n of no) assert.ok(!has(n, tag), `${n} should not be ${tag} (got ${tags(n).join(",")})`);
}

test("fixture shape: only the fields classifyCard reads, plus Tagger labels", () => {
  assert.ok(FIXTURE.cards.length >= 150, `${FIXTURE.cards.length} cards`);
  const keys = new Set(FIXTURE.cards.flatMap((c) => Object.keys(c)));
  assert.deepEqual([...keys].sort(), ["cmc", "commander_legal", "game_changer", "keywords", "name", "oracle_text",
    "otags", "produced_mana", "scryfall_id", "type_line"]);
});

test("fetchlands, Evolving Wilds, saga/transmute lands: no tutor and no ramp (nonland guard)", () => {
  for (const n of ["Marsh Flats", "Evolving Wilds", "Prismatic Vista", "Fabled Passage", "Terramorphic Expanse",
    "Urza's Saga", "Tolaria West", "Myriad Landscape", "Gaea's Cradle", "Dryad Arbor", "Command Tower"]) {
    assert.ok(isLand(card(n)), `${n} is a land`);
    assert.ok(!has(n, "tutor") && !has(n, "ramp"), `${n}: ${tags(n).join(",")}`);
  }
  // lands only get list facts
  assert.deepEqual(tags("Ancient Tomb"), ["game_changer", "fast_mana"]);
  assert.equal(tagOf(classifyCard(card("Ancient Tomb")), "fast_mana").source, "list");
  assert.ok(has("Gemstone Caverns", "fast_mana"));
  // an MDFC spell // land is a spell: the land back face adds no ramp
  assert.ok(!isLand(card("Valakut Awakening // Valakut Stoneforge")));
  assert.ok(!has("Valakut Awakening // Valakut Stoneforge", "ramp"));
});

test("tutor vs land search (land searches are ramp)", () => {
  expectTags("tutor",
    ["Demonic Tutor", "Vampiric Tutor", "Enlightened Tutor", "Worldly Tutor", "Mystical Tutor", "Imperial Seal",
      "Diabolic Intent", "Green Sun's Zenith", "Finale of Devastation", "Natural Order", "Eladamri's Call",
      "Fabricate", "Stoneforge Mystic", "Steelshaper's Gift", "Gifts Ungiven", "Intuition", "Long-Term Plans",
      "Muddle the Mixture", "Dimir Machinations", "Drift of Phantasms", "Birthing Pod", "Chord of Calling"],
    ["Cultivate", "Kodama's Reach", "Rampant Growth", "Farseek", "Nature's Lore", "Three Visits", "Wood Elves",
      "Sakura-Tribe Elder", "Crop Rotation", "Path to Exile", "Settle the Wreckage", "Brainstorm",
      "Entomb", "Buried Alive"]);
  assert.equal(tagOf(classifyCard(card("Muddle the Mixture")), "tutor").why, "tutor_transmute");
  assert.equal(tagOf(classifyCard(card("Demonic Tutor")), "tutor").why, "tutor_search");
});

test("ramp: land search, mana permanents, extra land drops; not fast mana, not removal side effects", () => {
  expectTags("ramp",
    ["Cultivate", "Kodama's Reach", "Rampant Growth", "Farseek", "Nature's Lore", "Three Visits", "Wood Elves",
      "Sakura-Tribe Elder", "Burnished Hart", "Solemn Simulacrum", "Arcane Signet", "Mind Stone", "Fellwar Stone",
      "Talisman of Dominance", "Llanowar Elves", "Birds of Paradise", "Elvish Mystic", "Exploration",
      "Azusa, Lost but Seeking", "Burgeoning", "Commander's Sphere"],
    ["Sol Ring", "Mana Vault", "Path to Exile", "Swords to Plowshares", "Assassin's Trophy", "Crop Rotation",
      "Scapeshift", "Thran Dynamo", "Grizzly Bears", "Rhystic Study"]);
  assert.equal(tagOf(classifyCard(card("Arcane Signet")), "ramp").source, "scryfall");
  assert.equal(tagOf(classifyCard(card("Farseek")), "ramp").why, "ramp_type_search");
});

test("fast mana: list (incl. lands, spirit guides) and the net-mana rule", () => {
  expectTags("fast_mana",
    ["Sol Ring", "Mana Vault", "Mana Crypt", "Grim Monolith", "Chrome Mox", "Mox Diamond", "Mox Opal",
      "Mox Amber", "Jeweled Lotus", "Lotus Petal", "Lion's Eye Diamond", "Ancient Tomb", "Gemstone Caverns",
      "Dark Ritual", "Cabal Ritual", "Rite of Flame", "Simian Spirit Guide", "Elvish Spirit Guide"],
    ["Llanowar Elves", "Birds of Paradise", "Arcane Signet", "Mind Stone", "Everflowing Chalice", "Manamorphose",
      "Wayfarer's Bauble", "Coalition Relic", "Basalt Monolith"]);
  assert.equal(tagOf(classifyCard(card("Sol Ring")), "fast_mana").source, "list");
  // the net-mana rule alone (a renamed ritual is still caught)
  const ritual = { name: "Test Ritual", type_line: "Instant", cmc: 1, oracle_text: "Add {B}{B}{B}.", keywords: "[]" };
  assert.equal(tagOf(classifyCard(ritual), "fast_mana").why, "fast_mana_net");
  const tapped = { name: "Slow Rock", type_line: "Artifact", cmc: 1, oracle_text: "This artifact enters tapped.\n{T}: Add {C}{C}.", keywords: "[]" };
  assert.ok(!hasTag(classifyCard(tapped), "fast_mana"));
  const unknownCmc = { name: "Odd Rock", type_line: "Artifact", cmc: null, oracle_text: "{T}: Add {C}{C}.", keywords: "[]" };
  assert.ok(!hasTag(classifyCard(unknownCmc), "fast_mana"));
});

test("card draw: engine vs burst vs cantrip; opponents drawing is no engine", () => {
  expectTags("draw_engine",
    ["Rhystic Study", "Mystic Remora", "Phyrexian Arena", "Esper Sentinel", "Skullclamp", "Sylvan Library",
      "Beast Whisperer", "Guardian Project", "Archmage Emeritus", "Wheel of Fortune", "Windfall"],
    ["Orcish Bowmasters", "Smothering Tithe", "Ponder", "Brainstorm", "Harmonize", "Night's Whisper"]);
  expectTags("draw_burst", ["Harmonize", "Night's Whisper", "Sign in Blood", "Brainstorm", "Treasure Cruise", "Wheel of Fortune"],
    ["Ponder", "Opt", "Rhystic Study", "Preordain"]);
  expectTags("cantrip", ["Ponder", "Preordain", "Opt"],
    ["Brainstorm", "Harmonize", "Rhystic Study", "Phyrexian Arena", "Mulldrifter", "Elvish Visionary"]);
});

test("removal, counters, wipes", () => {
  expectTags("removal",
    ["Swords to Plowshares", "Path to Exile", "Beast Within", "Chaos Warp", "Generous Gift", "Anguished Unmaking",
      "Lightning Bolt", "Chain Lightning", "Cyclonic Rift", "Rapid Hybridization", "Pongify", "Murder", "Doom Blade",
      "Go for the Throat", "Fatal Push", "Infernal Grasp", "Hero's Downfall", "Ravenous Chupacabra", "Dismember",
      "Feed the Swarm", "Vindicate", "Krosan Grip", "Nature's Claim", "Return to Dust", "Assassin's Trophy",
      "Solitude", "Deadly Rollick", "Snuff Out", "Aura Shards", "Heliod's Intervention", "Kaya's Guile"],
    ["Stone Rain", "Armageddon", "Ghostly Flicker", "Counterspell", "Wrath of God", "Epicenter", "Grizzly Bears",
      "Tireless Tracker"]);
  expectTags("counter",
    ["Counterspell", "Mana Drain", "Swan Song", "Negate", "An Offer You Can't Refuse", "Force of Will",
      "Force of Negation", "Fierce Guardianship", "Pact of Negation", "Mental Misstep", "Flusterstorm",
      "Mindbreak Trap", "Daze", "Dovin's Veto", "Arcane Denial", "Mystic Confluence"],
    ["Misdirection", "Commandeer", "Deflecting Swat", "Swords to Plowshares", "Rhystic Study"]);
  expectTags("wipe",
    ["Wrath of God", "Damnation", "Toxic Deluge", "Blasphemous Act", "Pestilence", "Massacre Wurm", "Evacuation",
      "Austere Command", "Farewell", "Merciless Eviction", "Vanquish the Horde", "Settle the Wreckage",
      "Kozilek's Return", "Cyclonic Rift", "Vandalblast", "Damn", "Aetherize"],
    ["Swords to Plowshares", "Armageddon", "Ruination", "Lightning Bolt", "Beast Within", "Ghostly Flicker"]);
});

test("free interaction: alt-cost text or the curated list, protection on instants", () => {
  expectTags("free_interaction",
    ["Force of Will", "Fierce Guardianship", "Deflecting Swat", "Deadly Rollick", "Snuff Out", "Pact of Negation",
      "Mental Misstep", "Flusterstorm", "Mindbreak Trap", "Daze", "Force of Negation", "Solitude", "Subtlety"],
    ["Counterspell", "Swords to Plowshares", "Mana Drain", "Cyclonic Rift"]);
  const altCost = { name: "Test Blast", type_line: "Instant", cmc: 3,
    oracle_text: "If you control a commander, you may cast this spell without paying its mana cost.\nDestroy target artifact.", keywords: "[]" };
  assert.equal(tagOf(classifyCard(altCost), "free_interaction").why, "free_alt_cost");
  expectTags("protection", ["Teferi's Protection", "Heroic Intervention", "Flawless Maneuver", "Boros Charm", "Clever Concealment"],
    ["Swords to Plowshares", "Counterspell", "Grizzly Bears"]);
});

test("mass land denial vs single land destruction", () => {
  expectTags("mld",
    ["Armageddon", "Ravages of War", "Catastrophe", "Jokulhaups", "Obliterate", "Decree of Annihilation", "Ruination",
      "Sunder", "Winter Orb", "Static Orb", "Hokori, Dust Drinker", "Blood Moon", "Magus of the Moon", "Back to Basics",
      "Rising Waters", "Contamination", "Epicenter"],
    ["Stone Rain", "Strip Mine", "Wasteland", "Tectonic Edge", "Ghost Quarter", "Acidic Slime", "Plow Under",
      "Vandalblast", "Wrath of God"]);
  // the regexes on their own (not on MLD_LIST)
  const t = (oracle_text) => classifyCard({ name: "X", type_line: "Sorcery", cmc: 4, oracle_text, keywords: "[]" });
  assert.equal(tagOf(t("Destroy all lands."), "mld").why, "mld_all_lands");
  assert.equal(tagOf(t("Each player sacrifices four lands of their choice."), "mld").why, "mld_sacrifice");
  assert.equal(tagOf(t("Lands don't untap during their controllers' untap steps."), "mld").why, "mld_no_untap");
  assert.equal(tagOf(t("Nonbasic lands are Swamps."), "mld").why, "mld_nonbasic");
  assert.ok(!hasTag(t("Destroy target land."), "mld"));
  // single/targeted "don't untap" is not mass land denial
  assert.ok(!hasTag(t("Choose one —\n• Chandra's Revolution deals 4 damage to target creature.\n• Tap target land. That land doesn't untap during its controller's next untap step."), "mld"), "Chandra's Revolution");
  assert.ok(!hasTag(t("When this creature enters, tap target land an opponent controls. That land doesn't untap during its controller's next untap step."), "mld"), "Stensia Innkeeper");
  assert.ok(!hasTag(t("Tap up to three target lands. Those lands don't untap during their controller's next untap step."), "mld"));
  assert.ok(!hasTag(t("Up to three target lands don't untap during their controllers' next untap steps."), "mld"));
  assert.equal(tagOf(t("Islands don't untap during their controllers' untap steps."), "mld")?.why, "mld_no_untap", "Choke: all Islands");
  assert.equal(tagOf(t("Nonbasic lands don't untap during their controllers' untap steps."), "mld")?.why, "mld_no_untap");
  assert.equal(tagOf(t("Flying\nLands you don't control don't untap during their controllers' untap steps."), "mld")?.why, "mld_no_untap");
});

test("extra turns; skip-before-take does not count", () => {
  expectTags("extra_turn",
    ["Time Warp", "Temporal Manipulation", "Capture of Jingzhou", "Nexus of Fate", "Expropriate", "Time Stretch",
      "Karn's Temporal Sundering", "Medomai the Ageless", "Sage of Hours", "Part the Waterveil", "Notorious Throng",
      "Lighthouse Chronologist", "Walk the Aeons", "Perch Protection"],
    ["Stranglehold", "Time Spiral", "Magosi, the Waterveil", "Grizzly Bears"]);
  const skip = { name: "X", type_line: "Enchantment", cmc: 3, oracle_text: "If a player would begin an extra turn, that player skips that turn instead.", keywords: "[]" };
  assert.ok(!hasTag(classifyCard(skip), "extra_turn"));
  const skipFirst = { name: "Y", type_line: "Sorcery", cmc: 3, oracle_text: "Skip your next draw step and take an extra turn after this one.", keywords: "[]" };
  assert.ok(!hasTag(classifyCard(skipFirst), "extra_turn"));
});

test("Game Changers: Scryfall flag first, GC_FALLBACK only for unknown flags (53 as of 2026-02-09)", () => {
  assert.equal(GC_FALLBACK.length, 53);
  assert.equal(new Set(GC_FALLBACK.map(normName)).size, 53);
  // the recorded is:gamechanger answer is exactly the fallback list
  const flagged = FIXTURE.cards.filter((c) => c.game_changer === 1).map((c) => normName(c.name)).sort();
  assert.deepEqual(flagged, GC_FALLBACK.map(normName).sort());
  assert.equal(tagOf(classifyCard(card("Rhystic Study")), "game_changer").source, "scryfall");
  const unknown = { ...card("Rhystic Study"), scryfall_id: null, game_changer: null };
  assert.deepEqual(tagOf(classifyCard(unknown), "game_changer"), { tag: "game_changer", source: "list", why: "gc_list" });
  const notGc = { ...card("Rhystic Study"), scryfall_id: null, game_changer: 0 };
  assert.ok(!hasTag(classifyCard(notGc), "game_changer"), "a known 0 flag beats the name list");
  assert.ok(!has("Sol Ring", "game_changer"));
});

test("curated lists are clean (unique names; plan sizes)", () => {
  for (const [list, min, max] of [[FAST_MANA, 20, 35], [MLD_LIST, 20, 40], [FREE_INTERACTION_EXTRA, 9, 30]]) {
    assert.equal(new Set(list.map(normName)).size, list.length);
    assert.ok(list.length >= min && list.length <= max, `${list.length}`);
  }
  for (const t of classifyCard(card("Force of Will"))) assert.ok(CARD_TAGS.includes(t.tag));
});

test("classifyByName for unresolved rows: normalised names against GC/MLD/fast-mana lists", () => {
  assert.deepEqual(classifyByName("  RHYSTIC study ").tags.map((t) => t.tag), ["game_changer"]);
  assert.equal(classifyByName("Rhystic Study").tags[0].source, "name");
  assert.deepEqual(classifyByName("Lim-Dûl's Vault").tags, []);
  assert.equal(classifyByName("Lim-Dûl's Vault").known, false);
  assert.deepEqual(classifyByName("Hokori, Dust Drinker").tags.map((t) => t.tag), ["mld"]);
  assert.deepEqual(classifyByName("Sol Ring").tags.map((t) => t.tag), ["fast_mana"]);
  assert.deepEqual(classifyByName("Mana Vault").tags.map((t) => t.tag), ["game_changer", "fast_mana"]);
  assert.deepEqual(classifyByName("Boom // Bust").tags.map((t) => t.tag), ["mld"]);
  assert.deepEqual(classifyByName("Tergrid, God of Fright // Tergrid's Lantern").tags.map((t) => t.tag), ["game_changer"]);
  assert.deepEqual(classifyByName("Lion’s Eye Diamond").tags.map((t) => t.tag), ["game_changer", "fast_mana"]);
});

test("memo per scryfall_id|fetched_at; Spellbook flags merge per deck without touching it", () => {
  clearClassifyMemo();
  const c = { ...card("Time Warp"), fetched_at: "2026-10-15T00:00:00Z" };
  const first = classifyCard(c);
  assert.equal(classifyCard({ ...c }), first, "same key → same memoised array");
  assert.ok(Object.isFrozen(first));
  // a Spellbook cache change: merged per deck, the memo stays as it was
  const merged = mergeSpellbook(first, { gameChanger: true, extraTurn: true, massLandDenial: false });
  assert.equal(tagOf(merged, "extra_turn").source, "spellbook");
  assert.equal(tagOf(merged, "game_changer").source, "spellbook");
  assert.ok(!hasTag(merged, "mld"));
  const again = classifyCard({ ...c });
  assert.equal(again, first);
  assert.deepEqual(again.map((t) => `${t.tag}:${t.source}`), ["extra_turn:regex"]);
  // a refetch (new fetched_at) re-classifies
  assert.notEqual(classifyCard({ ...c, fetched_at: "2026-10-16T00:00:00Z" }), first);
  assert.deepEqual(classifyCard(null), []);
});

test("textOf joins oracle text and keywords (JSON string or array)", () => {
  assert.equal(textOf({ oracle_text: "Flying", keywords: '["Flying","Ward"]' }), "Flying\nFlying\nWard");
  assert.equal(textOf({ oracle_text: null, keywords: ["Transmute"] }), "\nTransmute");
  assert.equal(textOf({ keywords: "not json" }), "\n");
});

// ---- precision / recall against Scryfall Tagger ------------------------------

// Our tag(s) per Tagger otag. Evaluated on commander-legal nonland cards (the
// nonland guard is a design choice; banned cards have no f:commander otags).
const MAP = {
  tutor: ["tutor"],
  ramp: ["ramp", "fast_mana"],
  draw: ["draw_engine", "draw_burst", "cantrip"],
  removal: ["removal", "wipe"],
  counterspell: ["counter"],
  "board-wipe": ["wipe"],
  "extra-turn": ["extra_turn"],
  "mass-land-denial": ["mld"],
};
// By design (plan §5), not misses: land-only searches are ramp, land
// destruction is MLD (or nothing), never removal or a board wipe.
const landOnlySearch = (c) => {
  const s = String(c.oracle_text || "").match(/search (?:your|their) library[^.]*\./gi) || [];
  return s.length > 0 && s.every((x) => /\bland\b|\b(?:Plains|Island|Swamp|Mountain|Forest)\b/i.test(x));
};
const POLICY = {
  tutor: (c) => landOnlySearch(c),
  removal: (c, ours) => ours.includes("mld") || /target (?:nonbasic )?lands?\b/i.test(c.oracle_text || ""),
  "board-wipe": (c, ours) => ours.includes("mld"),
};
// Known misses (Tagger positives we don't tag), checked so new ones show up.
const KNOWN_MISSES = {
  tutor: ["Buried Alive", "Entomb", // to the graveyard: not a hand/top/battlefield tutor (plan §5)
    "Opposition Agent", "Path to Exile", "Settle the Wreckage", "Scheming Symmetry"], // opponents search
  ramp: ["Bucknard's Everfull Purse", "Expropriate", "Krark-Clan Ironworks", "Mana Drain", "Manamorphose",
    "Neheb, the Eternal", "Path to Exile", "Settle the Wreckage", "Smothering Tithe",
    "Tergrid, God of Fright // Tergrid's Lantern", "The Great Henge", "Thran Dynamo", "Ugin, the Spirit Dragon",
    "Wargate"],
  draw: ["Ad Nauseam", "Commander's Sphere", "Court of Locthwain", "Decree of Annihilation", "Decree of Pain",
    "Elvish Visionary", "Mind Stone", "Notion Thief", "Sensei's Divining Top", "Solemn Simulacrum",
    "Teferi, Master of Time", "The One Ring", "Tireless Tracker"],
  removal: ["Boros Charm", "Bounce Chamber", "Braids, Cabal Minion", "Humility", "Living Death",
    "Tergrid, God of Fright // Tergrid's Lantern"],
  counterspell: ["Hullbreaker Horror", "Sink into Stupor // Soporific Springs", "Subtlety"],
  "board-wipe": ["Liliana of the Veil", "Liliana, Dreadhorde General", "Living Death"],
  "extra-turn": [],
  "mass-land-denial": ["Liliana of the Veil", "Liliana, Dreadhorde General"],
};
// Plan §5 targets (removal/draw/ramp ≥ 0.8/0.7; tutor, extra turn, MLD, counter ≥ 0.9/0.8).
const TARGET = {
  tutor: [0.9, 0.8], "extra-turn": [0.9, 0.8], "mass-land-denial": [0.9, 0.8], counterspell: [0.9, 0.8],
  ramp: [0.8, 0.7], draw: [0.8, 0.7], removal: [0.8, 0.7], "board-wipe": [0.8, 0.7],
};

/** Precision/recall per Tagger otag (exported shape is used by the report). */
function evaluate() {
  const pool = FIXTURE.cards.filter((c) => c.commander_legal && !isLand(c));
  const rows = {};
  for (const [otag, ourTags] of Object.entries(MAP)) {
    let tp = 0, fp = 0, fn = 0, excluded = 0;
    const fps = [], fns = [];
    for (const c of pool) {
      const ours = classifyCard(c).map((t) => t.tag);
      const predicted = ourTags.some((t) => ours.includes(t));
      const actual = c.otags.includes(otag);
      if (!predicted && actual && POLICY[otag]?.(c, ours)) { excluded++; continue; }
      if (predicted && actual) tp++;
      else if (predicted) { fp++; fps.push(c.name); } else if (actual) { fn++; fns.push(c.name); }
    }
    rows[otag] = { precision: tp / (tp + fp), recall: tp / (tp + fn), tp, fp, fn, excluded, fps, fns };
  }
  return { pool: pool.length, rows };
}

test("precision/recall against Scryfall Tagger meets the plan targets", (t) => {
  const { pool, rows } = evaluate();
  t.diagnostic(`evaluated ${pool} commander-legal nonland cards of ${FIXTURE.cards.length}`);
  for (const [otag, r] of Object.entries(rows)) {
    t.diagnostic(`${otag.padEnd(17)} precision ${r.precision.toFixed(2)} recall ${r.recall.toFixed(2)} ` +
      `(tp ${r.tp} fp ${r.fp} fn ${r.fn}, by design ${r.excluded})`);
    const [p, rc] = TARGET[otag];
    assert.ok(r.precision >= p, `${otag} precision ${r.precision.toFixed(2)} < ${p}; FP: ${r.fps.join(" | ")}`);
    assert.ok(r.recall >= rc, `${otag} recall ${r.recall.toFixed(2)} < ${rc}; FN: ${r.fns.join(" | ")}`);
    const unexpected = r.fns.filter((n) => !KNOWN_MISSES[otag].includes(n));
    assert.deepEqual(unexpected, [], `${otag}: new misses`);
  }
});
