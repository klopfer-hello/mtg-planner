// v1.3.0 knowledge sources, offline: web cache, EDHREC staples, Spellbook owned combos, recent cards, deck gaps.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { upsertCards } from "../lib/db.js";
import { deckDetail, saveDeckRows } from "../lib/decks.js";
import { deckGaps, gapsText } from "../lib/deckgaps.js";
import { commanderStaples, edhrecSlug } from "../lib/edhrec.js";
import { findCombos, ownedNames } from "../lib/ownedcombos.js";
import { recentCards } from "../lib/recentcards.js";
import { normalizeCard } from "../lib/scryfall.js";
import { setSpellbookSettings } from "../lib/spellbook.js";
import { cachedJson } from "../lib/webcache.js";
import { ID, seedCards, seedCollection, tempDb } from "./fixtures.js";
import { stubWeb } from "./helpers/web.js";

const SWORDS = {
  id: "00000000-0000-0000-0000-0000000000a1", oracle_id: "o-swords", name: "Swords to Plowshares", set: "sta", set_name: "Strixhaven Mystical Archive",
  collector_number: "10", lang: "en", rarity: "uncommon", type_line: "Instant", mana_cost: "{W}", cmc: 1, colors: ["W"], color_identity: ["W"],
  oracle_text: "Exile target creature. Its controller gains life equal to its power.", keywords: [], legalities: { commander: "legal" }, prices: { eur: "2.00" },
};

let ctx;
before(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  upsertCards(ctx.db, [normalizeCard(SWORDS)]);
  seedCollection(ctx.db, [[ID.sol, 2], [ID.lightning, 4], [ID.counterspell, 2], [ID.atraxa, 1], [ID.forest, 20], [SWORDS.id, 1], [ID.serra, 1]]);
});
after(() => ctx.cleanup());

test("cachedJson: fresh hit, refetch after the TTL, stale fallback on errors, throws without a cache", async () => {
  let n = 0;
  const f = async () => ({ n: ++n });
  assert.equal((await cachedJson(ctx.db, "k", 60000, f)).data.n, 1);
  assert.equal((await cachedJson(ctx.db, "k", 60000, f)).cached, true);
  assert.equal((await cachedJson(ctx.db, "k", 0, f)).data.n, 2);
  const stale = await cachedJson(ctx.db, "k", 0, async () => { throw new Error("down"); });
  assert.deepEqual([stale.data.n, stale.stale, stale.error], [2, true, "down"]);
  await assert.rejects(() => cachedJson(ctx.db, "other", 0, async () => { throw new Error("down"); }), /down/);
});

test("EDHREC: slug, inclusion and synergy from the page, bracket page, cached", async () => {
  assert.equal(edhrecSlug("Atraxa, Praetors' Voice"), "atraxa-praetors-voice");
  assert.equal(edhrecSlug("Jötun Grunt"), "jotun-grunt");
  assert.equal(edhrecSlug("Esika, God of the Tree // The Prismatic Bridge"), "esika-god-of-the-tree");
  const page = { container: { json_dict: { cardlists: [
    { header: "New Cards", tag: "newcards", cardviews: [{ name: "Brand New", num_decks: 1, potential_decks: 10, synergy: 0.9 }] },
    { header: "Top Cards", tag: "topcards", cardviews: [{ name: "Sol Ring", num_decks: 950, potential_decks: 1000, synergy: 0.01 }, { name: "Doubling Season", num_decks: 600, potential_decks: 1000, synergy: 0.45 }] },
    { header: "Artifacts", tag: "artifacts", cardviews: [{ name: "Sol Ring", num_decks: 950, potential_decks: 1000, synergy: 0.01 }] },
  ] } } };
  const web = stubWeb([[/atraxa-praetors-voice\/upgraded\.json$/, () => page], [/atraxa-praetors-voice\.json$/, () => page]]);
  try {
    const r = await commanderStaples(ctx.db, "Atraxa, Praetors' Voice");
    assert.equal(r.decks, 1000);
    assert.deepEqual(r.cards.map((c) => [c.name, c.inclusion, c.synergy]), [["Sol Ring", 95, 1], ["Doubling Season", 60, 45]]);
    assert.equal((await commanderStaples(ctx.db, "Atraxa, Praetors' Voice", { bracket: 3 })).bracket, 3);
    const calls = web.calls.length;
    await commanderStaples(ctx.db, "Atraxa, Praetors' Voice");
    assert.equal(web.calls.length, calls);
    await assert.rejects(() => commanderStaples(ctx.db, "Nobody"), (err) => err.status === 404);
  } finally { web.restore(); }
});

test("owned combos: free names within the identity, Spellbook complete + one missing, off = error", async () => {
  assert.deepEqual(ownedNames(ctx.db, { identity: "u" }), ["Counterspell", "Sol Ring"]);
  assert.ok(ownedNames(ctx.db, { identity: null }).includes("Lightning Bolt"));
  assert.ok(!ownedNames(ctx.db, { identity: null }).includes("Forest"), "basics never");
  let body;
  const web = stubWeb([[/find-my-combos$/, (u, init) => {
    body = JSON.parse(init.body);
    return { results: {
      included: [{ id: 1, uses: [{ card: { name: "Sol Ring" } }, { card: { name: "Counterspell" } }], produces: [{ feature: { name: "Infinite mana" } }], bracketTag: "E", manaValueNeeded: 3, popularity: 5 }],
      almostIncluded: [{ id: 2, uses: [{ card: { name: "Sol Ring" } }, { card: { name: "Basalt Monolith" } }], produces: [{ feature: { name: "Infinite colorless mana" } }], bracketTag: "E", popularity: 9 }],
    } };
  }]]);
  try {
    const r = await findCombos(ctx.db, ["Sol Ring", "Counterspell"], { commanders: ["Atraxa, Praetors' Voice"] });
    assert.deepEqual(body, { main: [{ card: "Sol Ring" }, { card: "Counterspell" }], commanders: [{ card: "Atraxa, Praetors' Voice" }] });
    assert.deepEqual(r.complete.map((c) => [c.cards, c.bracket, c.mana_value]), [[["Sol Ring", "Counterspell"], 4, 3]]);
    assert.deepEqual(r.one_missing[0].missing, ["Basalt Monolith"]);
  } finally { web.restore(); }
  setSpellbookSettings(ctx.db, { enabled: false });
  await assert.rejects(() => findCombos(ctx.db, ["Sol Ring"]), /turned off/);
  setSpellbookSettings(ctx.db, { enabled: true });
});

test("recent cards: Scryfall search with filters, cards cached, roles and ownership, role filter", async () => {
  let q;
  const web = stubWeb([[/\/cards\/search/, (u) => {
    q = u.searchParams.get("q");
    return { data: [{ ...SWORDS, id: "00000000-0000-0000-0000-0000000000b1", oracle_id: "o-new", name: "Newest Removal" }, { ...SWORDS, id: "00000000-0000-0000-0000-0000000000b2", oracle_id: "o-new2", name: "Newest Bear", type_line: "Creature — Bear", oracle_text: "" }], has_more: false };
  }]]);
  try {
    const r = await recentCards(ctx.db, { identity: "WB", format: "commander", since: "2026-01-01", extra: "mv<=3" });
    assert.equal(q, "date>=2026-01-01 game:paper -is:reprint -t:basic id<=wb f:commander mv<=3");
    assert.deepEqual(r.cards.map((c) => [c.name, c.roles, c.owned]), [["Newest Removal", ["removal"], 0], ["Newest Bear", [], 0]]);
    assert.ok(ctx.db.prepare("SELECT 1 FROM cards WHERE name = 'Newest Removal'").get(), "cached for get_cards");
    const removal = await recentCards(ctx.db, { identity: "WB", format: "commander", since: "2026-01-01", extra: "mv<=3", role: "removal" });
    assert.deepEqual(removal.cards.map((c) => c.name), ["Newest Removal"]);
    assert.equal(web.calls.length, 1, "the same search is cached for a day");
  } finally { web.restore(); }
});

describe("deck gaps", () => {
  test("a thin Commander deck: LOW lands/ramp/removal with free in-identity candidates, never off-colour", () => {
    const id = saveDeckRows(ctx.db, { name: "Thin Atraxa", format: "commander", rows: [
      { name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1, board: "commander" },
      { name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1, board: "main" },
      { name: "Forest", scryfall_id: ID.forest, quantity: 20, board: "main" },
    ] });
    const g = deckGaps(ctx.db, deckDetail(ctx.db, id));
    assert.match(g.anchor.key, /^commander/);
    const by = Object.fromEntries(g.checks.map((c) => [c.metric, c]));
    assert.equal(by.lands.status, "low");
    assert.ok(by.lands.gap > 10);
    assert.equal(by.ramp.status, "low");
    assert.deepEqual(by.ramp.candidates.map((c) => c.name), ["Sol Ring"]);
    assert.deepEqual(by.removal.candidates.map((c) => c.name), ["Swords to Plowshares"], "Lightning Bolt is outside WUBG");
    const text = gapsText(g);
    assert.match(text, /^Compared with tuned Commander/);
    assert.match(text, /\nLOW  lands: 20 \(usual \d+(\.\d)?–\d+(\.\d)?, median \d+/);
    assert.match(text, /Lands are a floor/);
    assert.match(gapsText(g, { brief: true }), /^Anchors vs tuned Commander .*lands 20 \(low/);
  });

  test("Pauper decks use the Pauper cell; formats without anchors give null", () => {
    const id = saveDeckRows(ctx.db, { name: "Bolts", format: "pauper", rows: [{ name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4, board: "main" }] });
    assert.equal(deckGaps(ctx.db, deckDetail(ctx.db, id)).anchor.key, "pauper");
    const other = saveDeckRows(ctx.db, { name: "Kitchen", format: "casual", rows: [{ name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4, board: "main" }] });
    assert.equal(deckGaps(ctx.db, deckDetail(ctx.db, other)), null);
    assert.match(gapsText(null), /No anchors/);
  });
});
