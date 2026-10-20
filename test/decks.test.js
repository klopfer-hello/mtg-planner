// Decklist parsing, deck persistence and ownership/missing-cost math.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DeckError, bracketVerdict, canPair, deckComboRequest, deckDetail, deckPower, deckToText, draftDeck, eurForFinish, eurOfPrinting, exportDeck, findDeck,
  DECK_NOTES_MAX, addDeckCard, bulkDeckCards, listDecks, normalizeFormat, parseDecklist, powerLines, saveDeck, saveDeckRows, scoreText, setCommander, setDeckNotes, updateDeckCard,
} from "../lib/decks.js";
import { listDeckVersions } from "../lib/deckhistory.js";
import { CEDH_HINT } from "../lib/power.js";
import { SPELLBOOK_PARSER, deckPayloadRows, spellbookRequest } from "../lib/spellbook.js";
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
      { quantity: 1, name: "Arcane Signet", set: "cmm", collector_number: "1015", board: "main", finish: "foil" },
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
    assert.equal(boards("Companion"), "side");
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

  test("cards list the binders holding their copies (all printings, most first)", () => {
    seedCollection(ctx.db, [
      [ID.counterspell7ed, 1, { binder: "Blue" }],
      [ID.counterspell, 2, { binder: "Trade" }],
      [ID.counterspell, 1, { binder: "Blue", finish: "foil" }],
      [ID.counterspell, 1],
    ]);
    const deckId = saveDeckRows(ctx.db, { name: "B", rows: [
      { board: "main", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1 },
      { board: "main", name: "Serra Angel", scryfall_id: ID.serra, quantity: 1 },
    ] });
    const d = deckDetail(ctx.db, deckId);
    const card = (name) => d.cards.find((c) => c.name === name);
    assert.deepEqual(card("Counterspell").binders, [
      { binder: "Blue", quantity: 2 }, { binder: "Trade", quantity: 2 }, { binder: "", quantity: 1 },
    ]);
    assert.deepEqual(card("Serra Angel").binders, []);
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

// v0.7.0: stats, bracket, score and the cached combos in deckDetail / listDecks / deckToText,
// the draft (evaluate) path and the target-bracket verdict. Combos come from the cache only;
// rows are written straight into spellbook_cache (no network).
describe("deck power", () => {
  let ctx;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    seedCollection(ctx.db, [[ID.sol, 1], [ID.atraxa, 1], [ID.counterspell, 1], [ID.serra, 1], [ID.forest, 40], [ID.lightning, 4]]);
  });
  afterEach(() => ctx.cleanup());

  const commanderDeck = (extra = [], opts = {}) => saveDeckRows(ctx.db, {
    name: "Atraxa", format: opts.format === undefined ? "commander" : opts.format, rows: [
      { name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1, board: opts.noCommander ? "main" : "commander" },
      { name: "Sol Ring", scryfall_id: ID.sol, quantity: 1, board: "main" },
      { name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1, board: "main" },
      { name: "Forest", scryfall_id: ID.forest, quantity: 30, board: "main" },
      ...extra,
    ],
  });
  /** Cache a trimmed Spellbook result for a request key (what refreshCombos would write). */
  const cache = (key, result, fetchedAt = new Date().toISOString()) => ctx.db.prepare(
    `INSERT OR REPLACE INTO spellbook_cache (key, fetched_at, last_used_at, status, error, tag_raw, parser, result)
     VALUES (?, ?, ?, 'ok', NULL, ?, ?, ?)`,
  ).run(key, fetchedAt, fetchedAt, result.tag, SPELLBOOK_PARSER, JSON.stringify(result));
  const FAST_COMBO = {
    parser: SPELLBOOK_PARSER, tag: "R", gc: [], mld: [], extra_turns: [], banned: [], combos_total: 1, unresolved: [],
    combos: [{
      id: "1-2", cards: ["Sol Ring", "Counterspell"], produces: ["Win the game"], manaValueNeeded: 3, speed: 3,
      definitelyTwoCard: true, arguablyTwoCard: true, relevant: true, borderlineRelevant: false, lock: false, extraTurn: false,
      massLandDenial: false, skipTurns: false, controlAllOpponents: false, controlSomeOpponents: false,
    }],
  };

  test("commander deck: stats, power and a pending combo view; the request is not enumerable", () => {
    const d = deckDetail(ctx.db, commanderDeck());
    assert.equal(d.stats.total, 33);
    assert.equal(d.stats.lands, 30);
    assert.equal(d.power.commander, true);
    assert.equal(d.power.bracket.auto, 2);
    assert.equal(d.power.bracket.partial, true);
    assert.equal(d.power.bracket.display, "≥2");
    assert.equal(d.power.score.partial, true);
    assert.equal(d.power.legality.ok, false, "33 cards, not 100");
    assert.equal(d.combos.status, "pending");
    assert.equal(d.combos.needs_fetch, true);
    assert.deepEqual(d.combos.items, []);
    assert.ok(d.spellbook_request?.key);
    assert.ok(!Object.keys(d).includes("spellbook_request"));
    assert.equal(JSON.parse(JSON.stringify(d)).spellbook_request, undefined);
  });

  test("cached combos raise the bracket (fast 2-card combo → 4), with Spellbook links; list rows follow", () => {
    const id = commanderDeck();
    const key = deckComboRequest(ctx.db, id).key;
    assert.equal(key, deckDetail(ctx.db, id).spellbook_request.key, "same key from the list and from the detail");
    assert.equal(key, spellbookRequest(deckPayloadRows(ctx.db, id), { isCommander: true }).key, "same key as lib/spellbook.js builds");
    cache(key, FAST_COMBO);
    const d = deckDetail(ctx.db, id);
    assert.equal(d.combos.status, "ok");
    assert.equal(d.combos.checked, true);
    assert.equal(d.combos.tag, "R");
    assert.equal(d.combos.items[0].url, "https://commanderspellbook.com/combo/1-2/");
    assert.equal(d.power.bracket.auto, 4);
    assert.equal(d.power.bracket.display, "4");
    assert.equal(d.power.score.partial, false);
    const [row] = listDecks(ctx.db);
    assert.equal(row.bracket, 4);
    assert.equal(row.bracket_partial, false);
    assert.equal(row.bracket_display, "4");
    assert.equal(row.score, d.power.score.value);
    assert.equal(row.legal, false);
    assert.equal(row.combos_status, "ok");
    // Stale entries are still used ("combos from <date>") and ask for a refresh.
    cache(key, FAST_COMBO, "2020-01-01T00:00:00.000Z");
    const stale = deckDetail(ctx.db, id);
    assert.equal(stale.combos.status, "stale");
    assert.equal(stale.combos.needs_fetch, true);
    assert.equal(stale.power.bracket.auto, 4);
    assert.match(deckToText(stale), /\nBracket: 4 Optimized \(auto; combos from 2020-01-01\)/);
  });

  test("declared bracket wins the display; the memo follows deck changes", () => {
    const id = commanderDeck();
    cache(deckComboRequest(ctx.db, id).key, FAST_COMBO);
    ctx.db.prepare("UPDATE decks SET bracket_declared = 2 WHERE id = ?").run(id);
    let d = deckDetail(ctx.db, id);
    assert.equal(d.power.bracket.value, 2);
    assert.equal(d.power.bracket.auto, 4);
    assert.ok(d.power.bracket.reasons.some((r) => r.rule === "declared_below"));
    assert.match(deckToText(d), /\nBracket: 2 Core \(set by the user; rules: 4; combos checked/);
    assert.equal(listDecks(ctx.db)[0].bracket, 2);
    ctx.db.prepare("UPDATE decks SET bracket_declared = NULL WHERE id = ?").run(id);
    updateDeckCard(ctx.db, id, { name: "Counterspell", board: "main", quantity: 0 });
    d = deckDetail(ctx.db, id);
    assert.equal(d.power.bracket.declared, null);
    assert.equal(d.combos.status, "pending", "another card set: another cache key");
    assert.equal(d.stats.total, 32);
  });

  test("non-commander decks: stats only, no request", () => {
    const id = saveDeckRows(ctx.db, { name: "Burn", format: "modern", rows: [{ name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4, board: "main" }] });
    const d = deckDetail(ctx.db, id);
    assert.equal(d.stats.total, 4);
    assert.deepEqual(d.power, { commander: false, bracket: null, score: null, legality: null });
    assert.equal(d.combos, null);
    assert.equal(d.spellbook_request, null);
    assert.equal(deckComboRequest(ctx.db, id), null);
    const text = deckToText(d);
    assert.match(text, /\nStats: 4 cards · lands 0 · avg MV 1 · curve 0:0 1:4 /);
    assert.doesNotMatch(text, /\nBracket:|\nScore /);
    const row = listDecks(ctx.db)[0];
    assert.equal(row.bracket, null);
    assert.equal(row.score, null);
    assert.equal(row.legal, null);
  });

  test("a ManaBox deck without format but with a commander board is a commander deck", () => {
    const id = commanderDeck([], { format: null });
    assert.equal(deckDetail(ctx.db, id).power.commander, true);
    const plain = commanderDeck([], { format: null, noCommander: true });
    assert.equal(deckDetail(ctx.db, plain).power.commander, false, "33 cards, no commander board");
  });

  test("deckToText: Stats, Bracket, Score and legality lines after Value", () => {
    const id = commanderDeck([{ name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1, board: "main" }]);
    cache(deckComboRequest(ctx.db, id).key, FAST_COMBO);
    const lines = deckToText(deckDetail(ctx.db, id)).split("\n");
    const at = lines.findIndex((l) => l.startsWith("Value:"));
    assert.match(lines[at + 1], /^Stats: 34 cards · lands 30 · avg MV [\d.]+ · curve 0:0 1:2 2:1 3:0 4:0 5:0 6:0 7\+:0 · pips .* \/ sources /);
    assert.match(lines[at + 2], /^Bracket: 4 Optimized \(auto; combos checked \d{4}-\d\d-\d\d\) - 2-card combo Sol Ring \+ Counterspell, ≤4 mana \(3 mana\)/);
    assert.match(lines[at + 2], /Spellbook: Ruthless \(≈4\)/);
    assert.match(lines[at + 3], /^Score [\d.]+\/10: speed [\d.]+\/1 · fast mana 0\.2\/1\.75 · tutors 0\/1 · combos 1\.5\/2 · interaction [\d.]+\/1 · draw [\d.]+\/1 · ramp [\d.]+\/0\.75 · mana base [\d.]+\/0\.5/);
    assert.match(lines[at + 4], /^Not Commander-legal: .*Lightning Bolt/);
  });

  test("powerLines while combos are unchecked: ≥ and the reason once", () => {
    const d = deckDetail(ctx.db, commanderDeck());
    const [, bracket, score] = powerLines(d);
    assert.match(bracket, /^Bracket: ≥2 Core \(auto; combos not checked \(pending\)\) - No rule pushes it higher/);
    assert.equal(bracket.match(/combos not checked/g).length, 1);
    assert.match(score, /^Score ≥[\d.]+\/10: /);
    assert.equal(scoreText(null), null);
  });

  test("bracketVerdict: OK / OVER with the floor reasons / UNDER with the weakest categories", () => {
    const id = commanderDeck();
    cache(deckComboRequest(ctx.db, id).key, FAST_COMBO);
    const { power } = deckDetail(ctx.db, id);
    assert.equal(bracketVerdict(power, 4), "Target bracket 4: OK");
    assert.match(bracketVerdict(power, 3), /^Target bracket 3: OVER - 2-card combo Sol Ring \+ Counterspell/);
    assert.match(bracketVerdict(power, 2), /^Target bracket 2: OVER - /);
    assert.match(bracketVerdict(power, 5), /^Target bracket 5: UNDER - not cEDH-like.*weakest: /);
    // The thresholds in the text are CEDH_HINT's (not a stale copy).
    assert.ok(bracketVerdict(power, 5).includes(`≥${CEDH_HINT.fast_mana} fast mana`));
    assert.ok(bracketVerdict(power, 5).includes(`avg MV ≤ ${CEDH_HINT.avg_mv})`));
    // A deck the user set to 5 fits target 5.
    assert.match(bracketVerdict({ ...power, bracket: { ...power.bracket, declared: 5, cedh_hint: false } }, 5), /^Target bracket 5: OK \(the user set Bracket 5\)/);
    assert.equal(bracketVerdict(power, 0), null);
    assert.equal(bracketVerdict(power, "x"), null);

    const plain = deckDetail(ctx.db, commanderDeck([{ name: "Serra Angel", scryfall_id: ID.serra, quantity: 1, board: "main" }])); // another key, no cache: ≥2
    assert.match(bracketVerdict(plain.power, 2), /^Target bracket 2: OK \(combos not checked yet: it may still go up\)$/);
    assert.match(bracketVerdict(plain.power, 1), /^Target bracket 1: OK \(no rule pushes it above 2; Bracket 1 is about intent\)/);
    assert.match(bracketVerdict(plain.power, 4), /^Target bracket 4: UNDER - the rules give 2 Core, score [\d.]+; weakest: .+\(.+\)/);
    assert.match(bracketVerdict({ commander: false, bracket: null }, 3), /not a Commander deck/);
  });

  test("draftDeck + deckPower: a decklist checked without a deck row", async () => {
    const decks = ctx.db.prepare("SELECT COUNT(*) AS n FROM decks").get().n;
    const draft = await draftDeck(ctx.db, { text: "1 Sol Ring\n1 Counterspell\n1 Atraxa, Praetors' Voice\n30 Forest", commander: "Atraxa, Praetors' Voice" });
    assert.deepEqual(draft.rows.map((r) => [r.board, r.name, r.quantity]), [
      ["main", "Sol Ring", 1], ["main", "Counterspell", 1], ["main", "Forest", 30], ["commander", "Atraxa, Praetors' Voice", 1],
    ]);
    assert.equal(draft.commander, true);
    assert.equal(draft.deck.format, null);
    const saved = commanderDeck();
    assert.equal(draft.request.key, deckComboRequest(ctx.db, saved).key, "the draft and the saved deck share a cache entry");
    const view = { status: "ok", fetched_at: new Date().toISOString(), result: FAST_COMBO };
    const p = deckPower(ctx.db, draft.deck, draft.rows, { combos: view });
    assert.equal(p.power.bracket.auto, 4);
    assert.equal(p.stats.total, 33);
    assert.equal(p.combos.items.length, 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM decks").get().n, decks + 1, "only the saveDeckRows above");

    // A companion stays out of the request and out of the counted cards.
    const comp = await draftDeck(ctx.db, { text: "Companion\n1 Lightning Bolt\n\nCommander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Counterspell\n30 Forest" });
    assert.deepEqual(comp.rows.find((r) => r.name === "Lightning Bolt"), { ...comp.rows.find((r) => r.name === "Lightning Bolt"), board: "side", companion: 1 });
    assert.equal(comp.request.key, draft.request.key);
    // Not a commander deck: no request.
    const modern = await draftDeck(ctx.db, { text: "4 Lightning Bolt", format: "modern" });
    assert.equal(modern.commander, false);
    assert.equal(modern.request, null);
  });

  test("an unresolved front-face name is sent as its full name from the local cards table", () => {
    const id = commanderDeck([{ name: "Delver of Secrets", scryfall_id: null, quantity: 1, board: "main" }]);
    const req = deckComboRequest(ctx.db, id);
    assert.ok(req.names.includes("Delver of Secrets // Insectile Aberration"));
    assert.equal(req.key, spellbookRequest(deckPayloadRows(ctx.db, id), { isCommander: true }).key);
  });

  test("canPair is exported (lib/power.js uses it)", () => {
    const bg = { name: "B", type_line: "Legendary Enchantment — Background", oracle_text: "" };
    const chooser = { name: "A", type_line: "Legendary Creature", oracle_text: "Choose a Background" };
    assert.equal(canPair(chooser, bg), true);
    assert.equal(canPair(chooser, chooser), false);
  });
});

describe("setDeckNotes", () => {
  let ctx;
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
  });
  afterEach(() => ctx.cleanup());
  const versions = (id) => listDeckVersions(ctx.db, id).versions;
  const PLAN = "## Plan\n- ramp {G}";

  test("stores trimmed Markdown, records one history version per change, keeps the cards", () => {
    const id = saveDeckRows(ctx.db, { name: "N", rows: [{ board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 }] });
    const before = versions(id).length;
    assert.equal(setDeckNotes(ctx.db, id, "  ## Plan\r\n- ramp {G}\r\n  ", { actor: "claude" }), PLAN);
    assert.equal(ctx.db.prepare("SELECT description FROM decks WHERE id = ?").get(id).description, PLAN);
    const after = versions(id);
    assert.equal(after.length, before + 1);
    assert.equal(after[0].actor, "claude");
    assert.equal(setDeckNotes(ctx.db, id, PLAN), PLAN);
    assert.equal(versions(id).length, before + 1, "equal text = no new version");
    assert.equal(deckDetail(ctx.db, id).cards.length, 1);
    assert.match(deckToText(deckDetail(ctx.db, id)), /Notes \(Markdown[^\n]*\n## Plan\n- ramp \{G\}/);
  });

  test("empty clears, too long and unknown deck are refused", () => {
    const id = saveDeckRows(ctx.db, { name: "N", description: "old", rows: [] });
    assert.equal(setDeckNotes(ctx.db, id, "   "), null);
    assert.equal(ctx.db.prepare("SELECT description FROM decks WHERE id = ?").get(id).description, null);
    assert.throws(() => setDeckNotes(ctx.db, id, "x".repeat(DECK_NOTES_MAX + 1)), (e) => e instanceof DeckError && e.status === 400);
    assert.throws(() => setDeckNotes(ctx.db, 9999, "x"), (e) => e instanceof DeckError && e.status === 404);
    assert.throws(() => setDeckNotes(ctx.db, id, 42), (e) => e instanceof DeckError && e.status === 400);
  });
});

describe("addDeckCard / bulkDeckCards", () => {
  let ctx;
  let stub;
  beforeEach(() => {
    ctx = tempDb();
    stub = stubScryfall();
  });
  afterEach(() => { stub.restore(); ctx.cleanup(); });
  const rowsOf = (id) => ctx.db.prepare("SELECT board, name, quantity FROM deck_cards WHERE deck_id = ? ORDER BY board, name").all(id).map((r) => ({ ...r }));
  const versionCount = (id) => listDeckVersions(ctx.db, id).versions.length;

  test("adds by Scryfall id (fetched when not cached) and by name; merges an existing row; one version each", async () => {
    const id = saveDeckRows(ctx.db, { name: "D", rows: [] });
    const v0 = versionCount(id);
    const a = await addDeckCard(ctx.db, id, { scryfall_id: ID.sol });
    assert.deepEqual([a.name, a.board, a.added], ["Sol Ring", "main", 1]);
    assert.equal(stub.calls.length, 1, "the card row was fetched");
    await addDeckCard(ctx.db, id, { scryfall_id: ID.sol, quantity: 2 });
    assert.equal(stub.calls.length, 1, "cached card: no second fetch");
    await addDeckCard(ctx.db, id, { name: "lightning bolt", board: "side" });
    assert.deepEqual(rowsOf(id), [
      { board: "main", name: "Sol Ring", quantity: 3 },
      { board: "side", name: "Lightning Bolt", quantity: 1 },
    ]);
    assert.equal(versionCount(id), v0 + 3);
  });

  test("add refuses bad input and unknown cards", async () => {
    const id = saveDeckRows(ctx.db, { name: "D", rows: [] });
    const status = (p) => p.then(() => null, (e) => (e instanceof DeckError ? e.status : e));
    assert.equal(await status(addDeckCard(ctx.db, 9999, { name: "Sol Ring" })), 404);
    assert.equal(await status(addDeckCard(ctx.db, id, { name: "Sol Ring", board: "nope" })), 400);
    assert.equal(await status(addDeckCard(ctx.db, id, { name: "Sol Ring", quantity: 0 })), 400);
    assert.equal(await status(addDeckCard(ctx.db, id, { scryfall_id: "not-an-id" })), 400);
    assert.equal(await status(addDeckCard(ctx.db, id, {})), 400);
    assert.equal(await status(addDeckCard(ctx.db, id, { name: "No Such Card Anywhere" })), 404);
    assert.equal(await status(addDeckCard(ctx.db, id, { scryfall_id: "00000000-0000-0000-0000-000000000000" })), 404);
    assert.deepEqual(rowsOf(id), []);
  });

  test("bulk remove and move: one version, duplicates ignored, a missing row changes nothing", () => {
    seedCards(ctx.db);
    const id = saveDeckRows(ctx.db, { name: "D", rows: [
      { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
      { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4 },
      { board: "main", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 2 },
      { board: "side", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 1 },
    ] });
    const v0 = versionCount(id);
    assert.throws(() => bulkDeckCards(ctx.db, id, { action: "remove", items: [{ name: "Sol Ring", board: "main" }, { name: "Serra Angel", board: "main" }] }),
      (e) => e instanceof DeckError && e.status === 404);
    assert.equal(rowsOf(id).length, 4, "rolled back");
    const moved = bulkDeckCards(ctx.db, id, { action: "move", to_board: "side", items: [{ name: "lightning bolt", board: "main" }] });
    assert.deepEqual([moved.rows, moved.copies], [1, 4]);
    const removed = bulkDeckCards(ctx.db, id, { action: "remove", items: [
      { name: "Sol Ring", board: "main" }, { name: "Sol Ring", board: "main" }, { name: "Counterspell", board: "main" },
    ] });
    assert.deepEqual([removed.rows, removed.copies], [2, 3]);
    assert.deepEqual(rowsOf(id), [{ board: "side", name: "Lightning Bolt", quantity: 5 }]);
    assert.equal(versionCount(id), v0 + 2);
    for (const bad of [{ action: "burn", items: [{ name: "x", board: "main" }] }, { action: "remove", items: [] },
      { action: "move", items: [{ name: "Lightning Bolt", board: "side" }] }, { action: "remove", items: [{ name: "", board: "main" }] }]) {
      assert.throws(() => bulkDeckCards(ctx.db, id, bad), (e) => e instanceof DeckError && e.status === 400);
    }
    assert.throws(() => bulkDeckCards(ctx.db, 9999, { action: "remove", items: [{ name: "x", board: "main" }] }), (e) => e.status === 404);
  });
});
