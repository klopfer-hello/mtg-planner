// Deck guide: local facts, Claude answer cleaning, composing, storage (v18), generation with a fake runGuide.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDES_KEEP, GUIDE_SYSTEM, TECHNIQUES, cleanStrategy, composeGuide, generateGuide, guideFacts, guidePrompt, latestGuide, saveGuide,
} from "../lib/deckguide.js";
import { saveDeckRows } from "../lib/decks.js";
import { setDeckNotes } from "../lib/deckedit.js";
import { recordDeckVersion } from "../lib/deckhistory.js";
import { ID, seedCards, tempDb } from "./fixtures.js";

const STRATEGY = {
  summary: "A flying deck. You win in the air.",
  how_it_wins: ["Attack with fliers", "Burn the last points"],
  game_plan: { early: ["Play a land every turn", "Cast Sol Ring"], mid: ["Cast Serra Angel"], late: ["Swing with everything"] },
  mulligan: { keep: ["2-4 lands"], ship: ["No lands"] },
  key_cards: [{ name: "Serra Angel", why: "Big flier." }, { name: "Not In The Deck", why: "Made up." }, { name: "lightning bolt", why: "Removal and reach." }],
  techniques: [{ key: "evasion", tip: "Angels fly over blockers." }, { key: "made_up", tip: "x" }],
  pitfalls: ["Attacking into open mana"],
  practice: ["Goldfish 5 games"],
  glossary: [{ term: "Goldfish", meaning: "Playing alone to test a deck." }, { term: "Flying", meaning: "Duplicate of the fixed list." }],
};

describe("deck guide", () => {
  let ctx, deckId;
  const evasion = TECHNIQUES.find((t) => t.key === "evasion");
  const evasionMin = evasion.min;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    deckId = saveDeckRows(ctx.db, { name: "Angels", format: "commander", rows: [
      { board: "commander", name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1 },
      { board: "main", name: "Serra Angel", scryfall_id: ID.serra, quantity: 4 },
      { board: "main", name: "Delver of Secrets // Insectile Aberration", scryfall_id: ID.delver, quantity: 1 },
      { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 2 },
      { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
      { board: "main", name: "Forest", scryfall_id: ID.forest, quantity: 10 },
      { board: "maybe", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1 },
    ] });
    recordDeckVersion(ctx.db, deckId, { actor: "app" });
    // the fixtures have only three fliers; real decks need four for "evasion"
    evasion.min = 2;
  });
  afterEach(() => { evasion.min = evasionMin; ctx.cleanup(); });

  test("facts: commander, colours, techniques with their cards, keyword glossary, key cards; maybe board ignored", () => {
    const f = guideFacts(ctx.db, deckId);
    assert.equal(f.deck.name, "Angels");
    assert.deepEqual(f.commander.map((c) => c.name), ["Atraxa, Praetors' Voice"]);
    const evasion = f.techniques.find((t) => t.key === "evasion");
    assert.ok(evasion, JSON.stringify(f.techniques.map((t) => t.key)));
    assert.ok(evasion.cards.includes("Serra Angel") && evasion.cards.includes("Atraxa, Praetors' Voice"));
    assert.ok(f.glossary.some((g) => g.term === "Flying"));
    assert.ok(f.glossary.some((g) => g.term === "Commander"), "commander deck terms");
    assert.equal(f.key_cards[0].name, "Atraxa, Praetors' Voice");
    assert.ok(!f.list.some((c) => c.name === "Counterspell"));
    assert.equal(guideFacts(ctx.db, 9999), null);
    const prompt = guidePrompt(f);
    assert.match(prompt, /Commander: Atraxa/);
    assert.match(prompt, /- evasion \(Evasion\):/);
    assert.match(prompt, /4 Serra Angel \|/);
    assert.match(GUIDE_SYSTEM, /ONLY one JSON object/);
    assert.match(GUIDE_SYSTEM, /overextending: name the cards to hold back against board wipes/, "#080 play tip");
    for (const t of TECHNIQUES) assert.ok(t.what.length > 40 && t.what.length < 260, t.key);
  });

  test("cleanStrategy drops invented cards and technique keys, matches names case-insensitively, caps lists", () => {
    const f = guideFacts(ctx.db, deckId);
    const s = cleanStrategy({ ...STRATEGY, how_it_wins: Array(20).fill("x") }, f);
    assert.deepEqual(s.key_cards.map((k) => k.name), ["Serra Angel", "Lightning Bolt"]);
    assert.deepEqual(Object.keys(s.technique_tips), ["evasion"]);
    assert.equal(s.how_it_wins.length, 5);
    assert.equal(cleanStrategy(null, f), null);
    assert.equal(cleanStrategy({ pitfalls: ["x"] }, f), null, "no summary and no win plan = unusable");
  });

  test("composeGuide merges tips, Claude's key cards and extra glossary terms (no duplicates), drops the raw list", () => {
    const f = guideFacts(ctx.db, deckId);
    const g = composeGuide(f, cleanStrategy(STRATEGY, f));
    assert.equal(g.techniques.find((t) => t.key === "evasion").tip, "Angels fly over blockers.");
    assert.deepEqual(g.key_cards.map((k) => k.name), ["Serra Angel", "Lightning Bolt"]);
    for (const k of g.key_cards) assert.equal(k.image, f.list.find((c) => c.name === k.name).image, "Claude's key cards get the card images");
    assert.equal(g.glossary.filter((x) => x.term === "Flying").length, 1);
    assert.ok(g.glossary.some((x) => x.term === "Goldfish"));
    assert.equal(g.list, undefined);
    assert.equal(g.strategy.summary, STRATEGY.summary);
    const factsOnly = composeGuide(f, null);
    assert.equal(factsOnly.strategy, null);
    assert.equal(factsOnly.key_cards[0].name, "Atraxa, Praetors' Voice");
  });

  test("generateGuide: Claude's answer → full guide; an error or junk → facts-only guide plus the error", async () => {
    let seen = null;
    const ok = await generateGuide(ctx.db, deckId, { runGuide: async (o) => { seen = o; return { json: STRATEGY, costUsd: 0.04 }; }, model: "sonnet" });
    assert.equal(ok.error, null);
    assert.equal(ok.row.kind, "full");
    assert.match(seen.system, /ONLY one JSON object/);
    assert.match(seen.prompt, /Decklist/);
    assert.equal(latestGuide(ctx.db, deckId).cost_usd, 0.04);
    const busy = await generateGuide(ctx.db, deckId, { runGuide: async () => ({ error: "Claude is busy", busy: true }) });
    assert.equal(busy.error, "Claude is busy");
    assert.equal(busy.row.kind, "facts");
    const junk = await generateGuide(ctx.db, deckId, { runGuide: async () => ({ json: { nope: 1 } }) });
    assert.match(junk.error, /not a usable guide/);
    const plain = await generateGuide(ctx.db, deckId);
    assert.equal(plain.error, null);
    assert.equal(plain.row.kind, "facts");
    assert.deepEqual(await generateGuide(ctx.db, 9999), { row: null, error: "Deck not found" });
  });

  test("storage: newest GUIDES_KEEP per deck, stale after a deck change, deleted with the deck", () => {
    const f = composeGuide(guideFacts(ctx.db, deckId), null);
    for (let i = 0; i < GUIDES_KEEP + 2; i++) saveGuide(ctx.db, deckId, { kind: "facts", guide: f });
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM deck_guides WHERE deck_id = ?").get(deckId).n, GUIDES_KEEP);
    assert.equal(latestGuide(ctx.db, deckId).stale, false);
    setDeckNotes(ctx.db, deckId, "new notes");
    assert.equal(latestGuide(ctx.db, deckId).stale, true);
    assert.throws(() => saveGuide(ctx.db, deckId, { kind: "nope", guide: f }), /kind must be/);
    ctx.db.prepare("DELETE FROM decks WHERE id = ?").run(deckId);
    assert.equal(latestGuide(ctx.db, deckId), null);
    assert.equal(saveGuide(ctx.db, deckId, { kind: "facts", guide: f }), null, "deck deleted meanwhile");
  });
});
