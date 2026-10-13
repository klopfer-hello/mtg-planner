// Decklist parsing, deck persistence and ownership/missing-cost math.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  deckDetail, deckToText, exportDeck, findDeck, listDecks, parseDecklist, saveDeck, saveDeckRows,
} from "../lib/decks.js";
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
    assert.match(text, /^Deck #\d+ "Test" \[commander\] \(source: manual\)/);
    assert.match(text, /Missing from collection: 5 cards \(~€22\.00\)/);
    assert.match(text, /1x Lightning Bolt \| \{R\} \| Instant \| MISSING 1 \(owned 1\) \| €2\.00/);
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
