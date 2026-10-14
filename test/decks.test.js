// Decklist parsing, deck persistence and ownership/missing-cost math.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DeckError, deckDetail, deckToText, eurForFinish, eurOfPrinting, exportDeck, findDeck, listDecks, normalizeFormat, parseDecklist, saveDeck, saveDeckRows,
  setCommander, updateDeckCard,
} from "../lib/decks.js";
import { upsertCards } from "../lib/db.js";
import { ID, seedCards, seedCollection, stubScryfall, tempDb } from "./fixtures.js";

describe("parseDecklist", () => {
  test("sections, quantities, set/number, foil markers", () => {
    const { items, errors } = parseDecklist([
      "Commander",
      "1 Atraxa, Praetors' Voice",
      "",
      "Deck",
      "1x Sol Ring (C21) 263",
      "1 Arcane Signet (CMM) 1015 *F*",
      "4 Lightning Bolt",
      "1 Delver of Secrets // Insectile Aberration (ISD) 51",
      "// a comment",
      "# another comment",
      "Sideboard:",
      "2 Duress",
      "Maybeboard",
      "1 Counterspell (MH2)",
    ].join("\n"));
    assert.deepEqual(errors, []);
    assert.deepEqual(items, [
      { quantity: 1, name: "Atraxa, Praetors' Voice", set: undefined, collector_number: undefined, board: "commander" },
      { quantity: 1, name: "Sol Ring", set: "c21", collector_number: "263", board: "main" },
      { quantity: 1, name: "Arcane Signet", set: "cmm", collector_number: "1015", board: "main" },
      { quantity: 4, name: "Lightning Bolt", set: undefined, collector_number: undefined, board: "main" },
      { quantity: 1, name: "Delver of Secrets // Insectile Aberration", set: "isd", collector_number: "51", board: "main" },
      { quantity: 2, name: "Duress", set: undefined, collector_number: undefined, board: "side" },
      { quantity: 1, name: "Counterspell", set: "mh2", collector_number: undefined, board: "maybe" },
    ]);
  });

  test("SB: and CMDR: prefixes, CRLF, no section headers", () => {
    const { items } = parseDecklist("4 Lightning Bolt\r\nSB: 2 Duress\r\nCMDR: 1 Atraxa, Praetors' Voice\r\n1 Sol Ring");
    assert.deepEqual(items.map((i) => [i.board, i.quantity, i.name]), [
      ["main", 4, "Lightning Bolt"], ["side", 2, "Duress"], ["commander", 1, "Atraxa, Praetors' Voice"], ["main", 1, "Sol Ring"],
    ]);
  });

  test("other section header spellings", () => {
    const boards = (header) => parseDecklist(`${header}\n1 Sol Ring`).items[0].board;
    assert.equal(boards("Commanders"), "commander");
    assert.equal(boards("COMMANDER:"), "commander");
    assert.equal(boards("Mainboard"), "main");
    assert.equal(boards("Companion"), "main");
    assert.equal(boards("Side"), "side");
    assert.equal(boards("Maybe"), "maybe");
    assert.equal(boards("Considering"), "maybe");
  });

  test("unparseable lines are reported, not dropped silently", () => {
    const { items, errors } = parseDecklist("Sol Ring\n1 Lightning Bolt\nx4 Duress");
    assert.equal(items.length, 1);
    assert.deepEqual(errors, ["Sol Ring", "x4 Duress"]);
  });

  test("card names that start like a section header are still cards", () => {
    const { items } = parseDecklist("Sideboard\n1 Commander's Sphere\nDeck\n1 Side Effect");
    assert.deepEqual(items.map((i) => [i.board, i.name]), [["side", "Commander's Sphere"], ["main", "Side Effect"]]);
  });
});

describe("decks", () => {
  let ctx;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
  });
  afterEach(() => ctx.cleanup());

  test("ownership spans printings, is shared across boards, ignores basics and maybeboard cost", () => {
    seedCollection(ctx.db, [
      [ID.counterspell7ed, 1],      // deck uses the MH2 printing: still counts as owned
      [ID.lightning, 1],            // deck wants 1 main + 1 side: only one copy owned
      [ID.sol, 1, { binder: "A" }],
      [ID.sol, 1, { binder: "B" }], // two collection rows for the same printing
    ]);
    const deckId = saveDeckRows(ctx.db, {
      name: "Test", format: "commander", description: "unit test", rows: [
        { board: "commander", name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1 },
        { board: "main", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1 },
        { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1 },
        { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 2 },
        { board: "main", name: "Forest", scryfall_id: ID.forest, quantity: 30 },
        { board: "main", name: "Azorius Charm", scryfall_id: ID.azorius, quantity: 1 },
        { board: "main", name: "Mystery Card", scryfall_id: null, quantity: 2 },
        { board: "side", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1 },
        { board: "maybe", name: "Serra Angel", scryfall_id: ID.serra, quantity: 3 },
      ],
    });
    const d = deckDetail(ctx.db, deckId);
    const card = (board, name) => d.cards.find((c) => c.board === board && c.name === name);

    assert.deepEqual(d.counts, { commander: 1, main: 37, side: 1, maybe: 3 });
    assert.equal(d.cards[0].board, "commander", "commander first");

    assert.equal(card("commander", "Atraxa, Praetors' Voice").missing, 1);
    assert.equal(card("main", "Counterspell").owned, 1);
    assert.equal(card("main", "Counterspell").missing, 0);
    assert.equal(card("main", "Lightning Bolt").missing, 0);
    assert.equal(card("side", "Lightning Bolt").missing, 1, "the single owned Bolt is already used by the main deck");
    assert.equal(card("main", "Sol Ring").owned, 2);
    assert.equal(card("main", "Sol Ring").missing, 0);
    const forest = card("main", "Forest");
    assert.equal(forest.basic, true);
    assert.equal(forest.missing, 0);
    assert.equal(card("main", "Mystery Card").missing, 2);
    assert.equal(card("main", "Mystery Card").price, null);
    assert.equal(card("maybe", "Serra Angel").missing, 3);
    assert.deepEqual(card("main", "Azorius Charm").price, { value: 0.3, currency: "$" });

    // Missing (maybeboard excluded): Atraxa 1 + Azorius 1 + Mystery 2 + side Bolt 1 = 5
    assert.equal(d.missing_count, 5);
    // EUR only: Atraxa 20 + Bolt 2 (Azorius has only USD, Mystery has no price)
    assert.equal(d.missing_cost_eur, 22);

    const text = deckToText(d);
    assert.match(text, /^Deck #\d+ "Test" \[commander\] \(source: manual, status: idea/);
    assert.match(text, /To buy \(not owned at all\): 5 cards \(~€22\.00\)\./);
    assert.doesNotMatch(text, /In other built decks/);
    assert.match(text, /## side\n1x Lightning Bolt \| \{R\} \| Instant \| TO BUY 1, owned 1 \| €2\.00/);
    assert.match(text, /30x Forest .*\| basic \|/);
  });

  test("ownership by name for unresolved cards", () => {
    seedCollection(ctx.db, [[ID.serra, 2]]);
    const deckId = saveDeckRows(ctx.db, { name: "N", rows: [{ board: "main", name: "serra angel", scryfall_id: null, quantity: 3 }] });
    const c = deckDetail(ctx.db, deckId).cards[0];
    assert.equal(c.owned, 2);
    assert.equal(c.missing, 1);
  });

  test("exportDeck writes an importable list", () => {
    const deckId = saveDeckRows(ctx.db, { name: "E", rows: [
      { board: "commander", name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1 },
      { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
      { board: "main", name: "Mystery Card", scryfall_id: null, quantity: 1 },
      { board: "side", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 2 },
    ] });
    const text = exportDeck(deckDetail(ctx.db, deckId));
    assert.equal(text, [
      "Commander", "1 Atraxa, Praetors' Voice (2XM) 190", "",
      "Deck", "1 Mystery Card", "1 Sol Ring (C21) 263", "",
      "Sideboard", "2 Lightning Bolt (M10) 146", "",
    ].join("\n"));
    // Round trip through the parser.
    const { items, errors } = parseDecklist(text);
    assert.deepEqual(errors, []);
    assert.equal(items.length, 4);
    assert.deepEqual(items.find((i) => i.name === "Lightning Bolt"), { quantity: 2, name: "Lightning Bolt", set: "m10", collector_number: "146", board: "side" });
  });

  test("saveDeckRows merges duplicate rows, updates in place, matchByName", () => {
    const id = saveDeckRows(ctx.db, { name: "M", source: "manabox", rows: [
      { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
      { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
    ] });
    assert.equal(listDecks(ctx.db)[0].card_count, 2);
    const again = saveDeckRows(ctx.db, { name: "M", source: "manabox", matchByName: true, rows: [
      { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4 },
    ] });
    assert.equal(again, id);
    assert.equal(listDecks(ctx.db).length, 1);
    assert.equal(listDecks(ctx.db)[0].card_count, 4);
    // Same name but different source is a different deck.
    saveDeckRows(ctx.db, { name: "M", source: "manual", matchByName: true, rows: [] });
    assert.equal(listDecks(ctx.db).length, 2);
    // Updating by id keeps unspecified metadata.
    saveDeckRows(ctx.db, { id, name: "M", format: "modern", rows: [] });
    saveDeckRows(ctx.db, { id, name: "M2", rows: [] });
    const row = ctx.db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
    assert.equal(row.name, "M2");
    assert.equal(row.format, "modern");
    assert.throws(() => saveDeckRows(ctx.db, { id: 9999, name: "x", rows: [] }), /not found/);
  });

  test("findDeck by id, exact name, partial name", () => {
    const a = saveDeckRows(ctx.db, { name: "Atraxa Superfriends", rows: [] });
    const b = saveDeckRows(ctx.db, { name: "Mono Red", rows: [] });
    assert.equal(findDeck(ctx.db, a).id, a);
    assert.equal(findDeck(ctx.db, String(b)).id, b);
    assert.equal(findDeck(ctx.db, "mono red").id, b);
    assert.equal(findDeck(ctx.db, "superfr").id, a);
    assert.equal(findDeck(ctx.db, "nope"), undefined);
    assert.equal(findDeck(ctx.db, ""), null);
  });

  test("deckDetail of an unknown deck is null", () => {
    assert.equal(deckDetail(ctx.db, 12345), null);
  });

  describe("saveDeck (Scryfall stubbed)", () => {
    let stub;
    beforeEach(() => { stub = stubScryfall(); });
    afterEach(() => stub.restore());

    test("prefers owned printings, looks up the rest, reports unresolved", async () => {
      seedCollection(ctx.db, [[ID.counterspell7ed, 1]]);
      const { items } = parseDecklist([
        "Commander", "1 Atraxa, Praetors' Voice",
        "Deck", "1 counterspell", "1 Sol Ring (C21) 263", "1 Delver of Secrets", "1 Not A Real Card",
      ].join("\n"));
      const { id, unresolved } = await saveDeck(ctx.db, { name: "S", format: "commander", source: "claude", items });
      assert.deepEqual(unresolved, ["Not A Real Card"]);
      const d = deckDetail(ctx.db, id);
      assert.equal(d.source, "claude");
      const byName = Object.fromEntries(d.cards.map((c) => [c.name, c]));
      assert.equal(byName.Counterspell.scryfall_id, ID.counterspell7ed, "owned printing chosen without a lookup");
      assert.equal(byName["Sol Ring"].scryfall_id, ID.sol);
      assert.equal(byName["Delver of Secrets // Insectile Aberration"].scryfall_id, ID.delver, "front face name resolves the DFC");
      assert.equal(byName["Not A Real Card"].scryfall_id, null);
      assert.equal(stub.calls.length, 1);
      assert.ok(!stub.calls[0].some((i) => /counterspell/i.test(i.name ?? "")));
    });

    test("updating an existing deck by id replaces its cards", async () => {
      const first = await saveDeck(ctx.db, { name: "U", source: "claude", items: [{ name: "Sol Ring", quantity: 1 }] });
      const second = await saveDeck(ctx.db, { id: first.id, name: "U", source: "claude", items: [{ name: "Lightning Bolt", quantity: 4, board: "bogus" }] });
      assert.equal(second.id, first.id);
      const d = deckDetail(ctx.db, first.id);
      assert.deepEqual(d.cards.map((c) => [c.board, c.name, c.quantity]), [["main", "Lightning Bolt", 4]]);
    });
  });
});

describe("deck value (EUR)", () => {
  let ctx;
  beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); });
  afterEach(() => ctx.cleanup());

  test("price helpers never fall back to USD", () => {
    assert.equal(eurForFinish('{"eur":"1.5","eur_foil":"4"}', "foil"), 4);
    assert.equal(eurForFinish('{"eur":"1.5"}', "foil"), null);
    assert.equal(eurForFinish({ usd: "3" }), null);
    assert.equal(eurOfPrinting({ eur_foil: "7" }), 7, "foil-only printing");
    assert.equal(eurOfPrinting({ usd: "1" }), null);
    assert.equal(eurOfPrinting(null), null);
  });

  test("owned copies at the owned finish price, missing at the deck printing, maybe apart, USD counted as unpriced", () => {
    seedCollection(ctx.db, [
      [ID.lightning, 1, { finish: "foil" }], // owned foil Bolt: €5.00
      [ID.counterspell7ed, 1],              // owned 7ED printing (€3.00) for a deck MH2 printing (€1.00)
    ]);
    const id = saveDeckRows(ctx.db, { name: "V", rows: [
      { board: "commander", name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1 }, // to buy €20
      { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 2 },            // 1 owned foil €5 + 1 to buy €2
      { board: "main", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1 },           // owned €3
      { board: "main", name: "Azorius Charm", scryfall_id: ID.azorius, quantity: 1 },               // USD only
      { board: "main", name: "Mystery Card", scryfall_id: null, quantity: 2 },                      // no price
      { board: "side", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },                        // to buy €1.50
      { board: "maybe", name: "Serra Angel", scryfall_id: ID.serra, quantity: 3 },                  // €0.30
    ] });
    const d = deckDetail(ctx.db, id);
    assert.deepEqual(d.value, { total_eur: 31.5, owned_eur: 8, to_buy_eur: 23.5, in_use_eur: 0, maybe_eur: 0.3, no_eur_price: 3 });
    assert.equal(d.missing_cost_eur, 23.5);
    const bolt = d.cards.find((c) => c.name === "Lightning Bolt");
    assert.equal(bolt.eur, 2);
    assert.equal(bolt.value_eur, 7);
    assert.equal(d.cards.find((c) => c.name === "Mystery Card").value_eur, null);
    assert.equal(listDecks(ctx.db).find((x) => x.id === id).value_eur, 31.5);
    assert.match(deckToText(d), /Value: €31\.50 \(owned €8\.00, to buy €23\.50; maybeboard €0\.30\); 3 cards have no EUR price\./);
  });

  test("owned copies shared across boards are valued once each", () => {
    seedCollection(ctx.db, [[ID.lightning, 1, { finish: "foil" }]]);
    const id = saveDeckRows(ctx.db, { name: "S", rows: [
      { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1 },
      { board: "side", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1 },
    ] });
    assert.deepEqual(deckDetail(ctx.db, id).value, { total_eur: 7, owned_eur: 5, to_buy_eur: 2, in_use_eur: 0, maybe_eur: 0, no_eur_price: 0 });
  });
});

describe("deck editing", () => {
  let ctx;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    // Partner / background test cards.
    const base = { set_code: "tst", set_name: "Test", collector_number: "1", lang: "en", rarity: "rare", cmc: 3, colors: "", color_identity: "",
      keywords: "[]", legalities: "{}", prices: '{"eur":"1.00"}', fetched_at: "x" };
    upsertCards(ctx.db, [
      { ...base, scryfall_id: "p1", oracle_id: "o-p1", name: "Thrasios", type_line: "Legendary Creature — Merfolk Wizard", oracle_text: "Partner", keywords: '["Partner"]' },
      { ...base, scryfall_id: "p2", oracle_id: "o-p2", name: "Tymna", type_line: "Legendary Creature — Human Cleric", oracle_text: "Partner", keywords: '["Partner"]' },
      { ...base, scryfall_id: "b1", oracle_id: "o-b1", name: "Wilson", type_line: "Legendary Creature — Bear Warrior", oracle_text: "Choose a Background" },
      { ...base, scryfall_id: "b2", oracle_id: "o-b2", name: "Raised by Giants", type_line: "Legendary Enchantment — Background", oracle_text: "Commander creatures you own have base power and toughness 10/10." },
      { ...base, scryfall_id: "pw", oracle_id: "o-pw", name: "Teferi", type_line: "Legendary Planeswalker — Teferi", oracle_text: "Teferi can be your commander." },
    ]);
  });
  afterEach(() => ctx.cleanup());

  const boards = (id) => Object.fromEntries(deckDetail(ctx.db, id).cards.map((c) => [`${c.board}:${c.name}`, c.quantity]));
  const deck = (format, rows) => saveDeckRows(ctx.db, { name: "E", format, rows: rows.map(([board, name, scryfall_id, quantity = 1]) => ({ board, name, scryfall_id, quantity })) });

  test("updateDeckCard sets quantities, removes with 0, moves and merges", () => {
    const id = deck("modern", [["main", "Lightning Bolt", ID.lightning, 4], ["side", "Lightning Bolt", ID.lightning, 1], ["main", "Sol Ring", ID.sol]]);
    assert.deepEqual(updateDeckCard(ctx.db, id, { name: "lightning bolt", board: "main", quantity: 3 }),
      { deck_id: id, name: "Lightning Bolt", board: "main", to_board: null, quantity: 3 });
    const moved = updateDeckCard(ctx.db, id, { name: "Lightning Bolt", board: "main", to_board: "side", quantity: 2 });
    assert.equal(moved.moved, 2);
    assert.deepEqual(boards(id), { "main:Lightning Bolt": 1, "side:Lightning Bolt": 3, "main:Sol Ring": 1 });
    // Move all (default), more than present is capped.
    updateDeckCard(ctx.db, id, { name: "Lightning Bolt", board: "side", to_board: "main", quantity: 99 });
    assert.deepEqual(boards(id), { "main:Lightning Bolt": 4, "main:Sol Ring": 1 });
    updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", to_board: "maybe" });
    updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "maybe", quantity: 0 });
    assert.deepEqual(boards(id), { "main:Lightning Bolt": 4 });
  });

  test("updateDeckCard validates", () => {
    const id = deck(null, [["main", "Sol Ring", ID.sol]]);
    const err = (fn, status) => assert.throws(fn, (e) => e instanceof DeckError && e.status === status);
    err(() => updateDeckCard(ctx.db, 999, { name: "Sol Ring", board: "main", quantity: 1 }), 404);
    err(() => updateDeckCard(ctx.db, id, { name: "Nope", board: "main", quantity: 1 }), 404);
    err(() => updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "deck", quantity: 1 }), 400);
    err(() => updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", to_board: "x" }), 400);
    err(() => updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main" }), 400);
    err(() => updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", quantity: -1 }), 400);
    err(() => updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", quantity: 1.5 }), 400);
    err(() => updateDeckCard(ctx.db, id, { board: "main", quantity: 1 }), 400);
  });

  test("setCommander moves one copy and replaces a commander that cannot pair", () => {
    const id = deck("commander", [["main", "Atraxa, Praetors' Voice", ID.atraxa], ["main", "Thrasios", "p1"], ["side", "Teferi", "pw"]]);
    assert.deepEqual(setCommander(ctx.db, id, { name: "Atraxa, Praetors' Voice" }), { deck_id: id, commanders: ["Atraxa, Praetors' Voice"], replaced: [] });
    const r = setCommander(ctx.db, id, { name: "Teferi" });
    assert.deepEqual(r.commanders, ["Teferi"]);
    assert.deepEqual(r.replaced, ["Atraxa, Praetors' Voice"]);
    assert.deepEqual(boards(id), { "commander:Teferi": 1, "main:Atraxa, Praetors' Voice": 1, "main:Thrasios": 1 });
    // Already the commander: no change.
    assert.deepEqual(setCommander(ctx.db, id, { name: "teferi" }).replaced, []);
    assert.throws(() => setCommander(ctx.db, id, { name: "Nope" }), (e) => e.status === 404);
  });

  test("partners and backgrounds pair up to two commanders in format commander", () => {
    const id = deck("Commander", [["main", "Thrasios", "p1"], ["main", "Tymna", "p2"], ["main", "Wilson", "b1"], ["main", "Raised by Giants", "b2"]]);
    setCommander(ctx.db, id, { name: "Thrasios" });
    assert.deepEqual(setCommander(ctx.db, id, { name: "Tymna" }).commanders, ["Thrasios", "Tymna"]);
    // A third replaces both (no pair of three).
    const r = setCommander(ctx.db, id, { name: "Wilson" });
    assert.deepEqual(r.commanders, ["Wilson"]);
    assert.deepEqual(r.replaced.sort(), ["Thrasios", "Tymna"]);
    assert.deepEqual(setCommander(ctx.db, id, { name: "Raised by Giants" }).commanders, ["Raised by Giants", "Wilson"]);
    // replace swaps out one specific commander.
    const s = setCommander(ctx.db, id, { name: "Thrasios", replace: "Raised by Giants" });
    assert.deepEqual(s.replaced, ["Raised by Giants", "Wilson"], "Thrasios cannot pair with Wilson either");
    assert.throws(() => setCommander(ctx.db, id, { name: "Tymna", replace: "Nobody" }), (e) => e.status === 404);
  });

  test("outside format commander a second partner replaces the first", () => {
    const id = deck("legacy", [["main", "Thrasios", "p1"], ["main", "Tymna", "p2"]]);
    setCommander(ctx.db, id, { name: "Thrasios" });
    assert.deepEqual(setCommander(ctx.db, id, { name: "Tymna" }).commanders, ["Tymna"]);
  });

  test("'Partner with X' and 'Partner—V' only pair with their named card / same variant", () => {
    const base = { set_code: "tst", set_name: "Test", collector_number: "2", lang: "en", rarity: "rare", cmc: 3, colors: "", color_identity: "",
      legalities: "{}", prices: "{}", fetched_at: "x", type_line: "Legendary Creature — Test" };
    upsertCards(ctx.db, [
      { ...base, scryfall_id: "w1", oracle_id: "o-w1", name: "Pir, Imaginative Rascal", keywords: '["Partner with", "Partner"]',
        oracle_text: "Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)\nIf one or more counters would be put on a permanent your team controls, that many plus one are put on it instead." },
      { ...base, scryfall_id: "w2", oracle_id: "o-w2", name: "Toothy, Imaginary Friend", keywords: '["Partner with", "Partner"]',
        oracle_text: "Partner with Pir, Imaginative Rascal (When this creature enters, target player may put Pir into their hand from their library, then shuffle.)\nWhenever you draw a card, put a +1/+1 counter on Toothy." },
      { ...base, scryfall_id: "v1", oracle_id: "o-v1", name: "Survivor A", keywords: '["Partner"]', oracle_text: "Partner—Survivors (You can have two commanders if both have this ability.)" },
      { ...base, scryfall_id: "v2", oracle_id: "o-v2", name: "Survivor B", keywords: '["Partner"]', oracle_text: "Flying\nPartner—Survivors (You can have two commanders if both have this ability.)" },
      { ...base, scryfall_id: "v3", oracle_id: "o-v3", name: "Other Variant", keywords: '["Partner"]', oracle_text: "Partner—Father & Son (You can have two commanders if both have this ability.)" },
    ]);
    const id = deck("commander", [["main", "Pir, Imaginative Rascal", "w1"], ["main", "Toothy, Imaginary Friend", "w2"], ["main", "Tymna", "p2"],
      ["main", "Survivor A", "v1"], ["main", "Survivor B", "v2"], ["main", "Other Variant", "v3"]]);
    setCommander(ctx.db, id, { name: "Pir, Imaginative Rascal" });
    // Generic Partner does not pair with "Partner with Toothy".
    assert.deepEqual(setCommander(ctx.db, id, { name: "Tymna" }).commanders, ["Tymna"]);
    setCommander(ctx.db, id, { name: "Pir, Imaginative Rascal" });
    assert.deepEqual(setCommander(ctx.db, id, { name: "Toothy, Imaginary Friend" }).commanders, ["Pir, Imaginative Rascal", "Toothy, Imaginary Friend"]);
    // Same variant pairs, a different variant or plain Partner replaces.
    setCommander(ctx.db, id, { name: "Survivor A" });
    assert.deepEqual(setCommander(ctx.db, id, { name: "Survivor B" }).commanders, ["Survivor A", "Survivor B"]);
    setCommander(ctx.db, id, { name: "Survivor A" });
    assert.deepEqual(setCommander(ctx.db, id, { name: "Other Variant" }).commanders, ["Other Variant"]);
    assert.deepEqual(setCommander(ctx.db, id, { name: "Tymna" }).commanders, ["Tymna"]);
  });

  test("formats are stored trimmed and lowercase", () => {
    const id = deck(" Commander ", [["main", "Atraxa, Praetors' Voice", ID.atraxa]]);
    assert.equal(deckDetail(ctx.db, id).format, "commander");
    assert.ok(Array.isArray(deckDetail(ctx.db, id).commander_suggestions));
    assert.equal(normalizeFormat("  "), null);
    assert.equal(normalizeFormat(null), null);
  });

  test("commander_suggestions for commander decks without one", () => {
    const id = deck("commander", [["main", "Atraxa, Praetors' Voice", ID.atraxa], ["main", "Sol Ring", ID.sol], ["maybe", "Teferi", "pw"],
      ["main", "Raised by Giants", "b2"]]);
    const d = deckDetail(ctx.db, id);
    assert.deepEqual(d.commander_suggestions.map((c) => [c.name, c.board]), [["Atraxa, Praetors' Voice", "main"], ["Teferi", "maybe"]]);
    assert.ok(d.commander_suggestions[0].image_small !== undefined);
    assert.match(deckToText(d), /No commander set\. Possible commanders in the deck: Atraxa, Praetors' Voice, Teferi\./);
    setCommander(ctx.db, id, { name: "Atraxa, Praetors' Voice" });
    assert.equal(deckDetail(ctx.db, id).commander_suggestions, undefined);
    const other = deck("modern", [["main", "Atraxa, Praetors' Voice", ID.atraxa]]);
    assert.equal(deckDetail(ctx.db, other).commander_suggestions, undefined);
  });
});
