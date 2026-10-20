// ManaBox CSV parsing and import (Scryfall is stubbed; no network).

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { importManaBoxCsv, parseCsv, refreshOwnedCards } from "../lib/manabox.js";
import { LIMITED_INTERVAL_MS, fetchCollection } from "../lib/scryfall.js";
import { deckDetail, listDecks } from "../lib/decks.js";
import { setCommander, updateDeckCard } from "../lib/deckedit.js";
import { ID, stubScryfall, tempDb } from "./fixtures.js";

describe("parseCsv", () => {
  test("header keys are lower-cased and trimmed, values trimmed", () => {
    assert.deepEqual(parseCsv("Name, Set code ,Quantity\nSol Ring , c21,2\n"), [
      { name: "Sol Ring", "set code": "c21", quantity: "2" },
    ]);
  });

  test("quoted fields with delimiters, escaped quotes and newlines", () => {
    const rows = parseCsv('Name,Note\n"Atraxa, Praetors\' Voice","say ""hi""\nsecond line"\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Atraxa, Praetors' Voice");
    assert.equal(rows[0].note, 'say "hi"\nsecond line');
  });

  test("CRLF line endings and blank lines", () => {
    const rows = parseCsv("Name,Quantity\r\nA,1\r\n\r\nB,2\r\n");
    assert.deepEqual(rows.map((r) => [r.name, r.quantity]), [["A", "1"], ["B", "2"]]);
  });

  test("UTF-8 BOM is stripped from the first header", () => {
    const rows = parseCsv("﻿Name,Quantity\nA,1");
    assert.deepEqual(Object.keys(rows[0]), ["name", "quantity"]);
    assert.equal(rows[0].quantity, "1", "last line without trailing newline is kept");
  });

  test("semicolon delimiter is detected from the header", () => {
    const rows = parseCsv('Name;Purchase price;Quantity\n"Bolt; the card";1,50;3\n');
    assert.deepEqual(rows, [{ name: "Bolt; the card", "purchase price": "1,50", quantity: "3" }]);
  });

  test("short rows are padded, empty input gives no rows", () => {
    assert.deepEqual(parseCsv("A,B,C\n1\n"), [{ a: "1", b: "", c: "" }]);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("Name,Quantity\n"), []);
  });
});

// A ManaBox collection export (binder export columns included).
const HEADER = "Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency";
const row = (binder, type, name, set, num, foil, qty, scryfallId, { price = "", condition = "near_mint", lang = "en" } = {}) =>
  [binder, type, `"${name}"`, set, "", num, foil, "", qty, "", scryfallId, price, "false", "false", condition, lang, price ? "EUR" : ""].join(",");
const csv = (...rows) => [HEADER, ...rows].join("\n") + "\n";

describe("importManaBoxCsv", () => {
  let ctx;
  let stub;
  beforeEach(() => { ctx = tempDb(); stub = stubScryfall(); });
  afterEach(() => { stub.restore(); ctx.cleanup(); });

  const owned = () => Object.fromEntries(
    ctx.db.prepare("SELECT scryfall_id, finish, SUM(quantity) AS q FROM collection GROUP BY scryfall_id, finish").all()
      .map((r) => [`${r.scryfall_id}/${r.finish}`, r.q]),
  );

  test("rejects files that are not ManaBox exports", async () => {
    await assert.rejects(importManaBoxCsv(ctx.db, ""), /empty/);
    await assert.rejects(importManaBoxCsv(ctx.db, "Foo,Bar\n1,2\n"), /Not a ManaBox collection export/);
  });

  test("replace mode is a full sync", async () => {
    const first = await importManaBoxCsv(ctx.db, csv(
      row("Box", "binder", "Sol Ring", "c21", "263", "normal", "2", ID.sol, { price: "1.25" }),
      row("Box", "binder", "Lightning Bolt", "m10", "146", "foil", "1", ID.lightning, { condition: "lightly played" }),
      row("Box", "binder", "Lightning Bolt", "m10", "146", "normal", "3", ID.lightning),
    ), { filename: "first.csv" });
    assert.equal(first.mode, "replace");
    assert.equal(first.rows, 3);
    assert.equal(first.imported_rows, 3);
    assert.equal(first.printings, 2);
    assert.equal(first.total_cards_before, 0);
    assert.equal(first.total_cards_after, 6);
    assert.equal(first.printings_added, 2);
    assert.deepEqual(first.unresolved, []);
    assert.deepEqual(owned(), { [`${ID.sol}/normal`]: 2, [`${ID.lightning}/foil`]: 1, [`${ID.lightning}/normal`]: 3 });

    const sol = ctx.db.prepare("SELECT * FROM collection WHERE scryfall_id = ?").get(ID.sol);
    assert.equal(sol.purchase_price, 1.25);
    assert.equal(sol.purchase_currency, "EUR");
    assert.equal(sol.binder, "Box");
    const foil = ctx.db.prepare("SELECT condition FROM collection WHERE finish = 'foil'").get();
    assert.equal(foil.condition, "lightly_played");
    assert.equal(ctx.db.prepare("SELECT name FROM cards WHERE scryfall_id = ?").get(ID.lightning).name, "Lightning Bolt");

    // Second export: the Sol Ring was traded away, Bolt count changed, Serra is new.
    const second = await importManaBoxCsv(ctx.db, csv(
      row("Box", "binder", "Lightning Bolt", "m10", "146", "normal", "2", ID.lightning),
      row("Box", "binder", "Serra Angel", "dmu", "33", "normal", "1", ID.serra),
    ));
    assert.equal(second.total_cards_before, 6);
    assert.equal(second.total_cards_after, 3);
    assert.equal(second.printings_added, 1);
    assert.equal(second.printings_removed, 1);
    assert.equal(second.printings_changed, 1);
    assert.deepEqual(owned(), { [`${ID.lightning}/normal`]: 2, [`${ID.serra}/normal`]: 1 });

    const imports = ctx.db.prepare("SELECT kind, filename, mode, summary FROM imports ORDER BY id").all();
    assert.equal(imports.length, 2);
    assert.equal(imports[0].filename, "first.csv");
    assert.equal(JSON.parse(imports[1].summary).total_cards_after, 3);
  });

  test("targetBinder puts every card into one binder; deck binders still become decks", async () => {
    const text = csv(
      row("Box", "binder", "Sol Ring", "c21", "263", "normal", "2", ID.sol),
      row("", "", "Lightning Bolt", "m10", "146", "normal", "1", ID.lightning),
      row("Elves", "deck", "Serra Angel", "dmu", "33", "normal", "1", ID.serra),
    );
    const first = await importManaBoxCsv(ctx.db, text, { targetBinder: "New Box" });
    const binders = ctx.db.prepare("SELECT binder, SUM(quantity) AS q FROM collection GROUP BY binder").all().map((r) => ({ ...r }));
    assert.deepEqual(binders, [{ binder: "New Box", q: 4 }]);
    assert.deepEqual(first.binders_created, ["New Box"]);
    assert.equal(ctx.db.prepare("SELECT origin FROM binders WHERE name = 'New Box'").get().origin, "app");
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM binders WHERE name IN ('Box', 'Elves')").get().n, 0);
    assert.deepEqual(listDecks(ctx.db).map((d) => d.name), ["Elves"]);
    // The snapshot uses the target, so the same file into the same binder adds nothing.
    const again = await importManaBoxCsv(ctx.db, text, { mode: "delta", targetBinder: "New Box" });
    assert.equal(again.added_copies, 0);
    assert.equal(again.decreased_copies, 0);
    assert.equal(ctx.db.prepare("SELECT SUM(quantity) AS q FROM collection").get().q, 4);
    // '' = Unsorted.
    await importManaBoxCsv(ctx.db, csv(row("Box", "binder", "Sol Ring", "c21", "263", "normal", "1", ID.sol)), { targetBinder: "" });
    assert.deepEqual(ctx.db.prepare("SELECT binder, quantity FROM collection").all().map((r) => ({ ...r })), [{ binder: "", quantity: 1 }]);
  });

  test("add mode merges quantities on top", async () => {
    const one = csv(row("", "", "Sol Ring", "c21", "263", "normal", "2", ID.sol));
    await importManaBoxCsv(ctx.db, one);
    const summary = await importManaBoxCsv(ctx.db, one, { mode: "add" });
    assert.equal(summary.mode, "add");
    assert.equal(summary.total_cards_after, 4);
    assert.equal(summary.printings_changed, 1);
    assert.deepEqual(owned(), { [`${ID.sol}/normal`]: 4 });
  });

  test("rows without a Scryfall ID resolve by set+number or by name", async () => {
    const summary = await importManaBoxCsv(ctx.db, [
      "Name,Set code,Collector number,Quantity,Foil",
      "Counterspell,7ed,67,2,normal",
      "Serra Angel,,,1,foil",
      "Delver of Secrets,isd,,1,normal",
      "Totally Fake Card,xyz,999,1,normal",
    ].join("\n"));
    assert.equal(summary.imported_rows, 3);
    assert.deepEqual(summary.unresolved, ["1x Totally Fake Card (XYZ 999)"]);
    assert.deepEqual(owned(), {
      [`${ID.counterspell7ed}/normal`]: 2,
      [`${ID.serra}/foil`]: 1,
      [`${ID.delver}/normal`]: 1,
    });
  });

  test("wish-list binders are skipped, deck binders become decks", async () => {
    const text = csv(
      row("Wants", "list", "Atraxa, Praetors' Voice", "2xm", "190", "normal", "1", ID.atraxa),
      row("Atraxa EDH", "deck", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
      row("Atraxa EDH", "deck", "Counterspell", "mh2", "267", "normal", "1", ID.counterspell),
      row("Binder", "binder", "Counterspell", "7ed", "67", "normal", "1", ID.counterspell7ed),
    );
    const summary = await importManaBoxCsv(ctx.db, text);
    assert.equal(summary.skipped_wishlist_rows, 1);
    assert.equal(summary.imported_rows, 3);
    assert.deepEqual(summary.decks_from_binders, ["Atraxa EDH"]);
    assert.ok(!(`${ID.atraxa}/normal` in owned()), "wish-list cards are not owned");

    let decks = listDecks(ctx.db);
    assert.equal(decks.length, 1);
    assert.equal(decks[0].name, "Atraxa EDH");
    assert.equal(decks[0].source, "manabox");
    assert.equal(decks[0].card_count, 2);
    const detail = deckDetail(ctx.db, decks[0].id);
    assert.equal(detail.missing_count, 0);
    assert.equal(detail.cards.find((c) => c.name === "Counterspell").owned, 2, "ownership spans printings and binders");

    // Re-syncing updates the same deck instead of creating a duplicate.
    await importManaBoxCsv(ctx.db, text);
    decks = listDecks(ctx.db);
    assert.equal(decks.length, 1);
    assert.equal(decks[0].card_count, 2);
  });

  test("add mode merges deck binder rows into the existing deck", async () => {
    await importManaBoxCsv(ctx.db, csv(
      row("My Deck", "deck", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
      row("My Deck", "deck", "Lightning Bolt", "m10", "146", "normal", "1", ID.lightning),
    ));
    await importManaBoxCsv(ctx.db, csv(
      row("My Deck", "deck", "Serra Angel", "dmu", "33", "normal", "1", ID.serra),
      row("My Deck", "deck", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
    ), { mode: "add" });
    const decks = listDecks(ctx.db);
    assert.equal(decks.length, 1);
    const cards = Object.fromEntries(deckDetail(ctx.db, decks[0].id).cards.map((c) => [c.name, c.quantity]));
    assert.deepEqual(cards, { "Sol Ring": 2, "Lightning Bolt": 1, "Serra Angel": 1 });
  });

  test("replace mode removes decks of binders that are gone, keeps other decks", async () => {
    await importManaBoxCsv(ctx.db, csv(
      row("Old Deck", "deck", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
      row("Kept Deck", "deck", "Lightning Bolt", "m10", "146", "normal", "1", ID.lightning),
    ));
    ctx.db.prepare("INSERT INTO decks (name, source) VALUES ('Old Deck', 'manual')").run();
    const summary = await importManaBoxCsv(ctx.db, csv(
      row("Kept Deck", "deck", "Lightning Bolt", "m10", "146", "normal", "1", ID.lightning),
    ));
    assert.deepEqual(summary.decks_removed, ["Old Deck"]);
    assert.deepEqual(listDecks(ctx.db).map((d) => `${d.name}/${d.source}`).sort(), ["Kept Deck/manabox", "Old Deck/manual"]);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM deck_cards").get().n, 1, "deck cards cascade");
  });

  test("a replace import with nothing importable leaves the collection alone", async () => {
    await importManaBoxCsv(ctx.db, csv(row("", "", "Sol Ring", "c21", "263", "normal", "2", ID.sol)));
    const wishlist = csv(row("Wants", "list", "Atraxa, Praetors' Voice", "2xm", "190", "normal", "1", ID.atraxa));
    await assert.rejects(importManaBoxCsv(ctx.db, wishlist), /Nothing importable/);
    await assert.rejects(importManaBoxCsv(ctx.db, "Name,Set code,Collector number\nFake,xyz,1\n"), /Nothing importable/);
    assert.deepEqual(owned(), { [`${ID.sol}/normal`]: 2 });
    // add mode with nothing importable is a harmless no-op
    const add = await importManaBoxCsv(ctx.db, wishlist, { mode: "add" });
    assert.equal(add.total_cards_after, 2);
  });

  test("malformed identifiers are reported unresolved, not sent to Scryfall", async () => {
    const summary = await importManaBoxCsv(ctx.db, csv(
      row("", "", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
      row("", "", "Broken", "c21", "263", "normal", "1", "not-a-uuid"),
      row("Box", "binder", "", "", "", "normal", "1", ""),
    ));
    assert.equal(summary.imported_rows, 1);
    assert.equal(summary.unresolved.length, 2);
    const sent = stub.calls.flat();
    assert.deepEqual(sent, [{ id: ID.sol }]);
  });

  test("Scryfall lookups are batched and de-duplicated", async () => {
    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(row("", "", "Sol Ring", "c21", "263", "normal", "1", ID.sol, { lang: ["en", "de", "fr"][i] }));
    await importManaBoxCsv(ctx.db, csv(...lines));
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].length, 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM collection").get().n, 3, "one row per language");
  });

  test("refreshOwnedCards re-fetches owned printings", async () => {
    await importManaBoxCsv(ctx.db, csv(row("", "", "Sol Ring", "c21", "263", "normal", "1", ID.sol)));
    ctx.db.prepare("UPDATE cards SET prices = '{}' WHERE scryfall_id = ?").run(ID.sol);
    const res = await refreshOwnedCards(ctx.db);
    assert.deepEqual(res, { refreshed: 1, not_found: 0 });
    assert.equal(JSON.parse(ctx.db.prepare("SELECT prices FROM cards WHERE scryfall_id = ?").get(ID.sol).prices).eur, "1.50");
  });

  test("a replace re-sync keeps the user's board assignments for cards still in the binder", async () => {
    const binder = (...extra) => csv(
      row("EDH", "deck", "Atraxa, Praetors' Voice", "2xm", "190", "normal", "1", ID.atraxa),
      row("EDH", "deck", "Sol Ring", "c21", "263", "normal", "1", ID.sol),
      row("EDH", "deck", "Lightning Bolt", "m10", "146", "normal", "2", ID.lightning),
      ...extra,
    );
    await importManaBoxCsv(ctx.db, binder(row("EDH", "deck", "Serra Angel", "dmu", "33", "normal", "1", ID.serra)));
    const id = listDecks(ctx.db)[0].id;
    ctx.db.prepare("UPDATE decks SET format = 'commander' WHERE id = ?").run(id);
    setCommander(ctx.db, id, { name: "Atraxa, Praetors' Voice" });
    updateDeckCard(ctx.db, id, { name: "Lightning Bolt", board: "main", to_board: "side", quantity: 1 });
    updateDeckCard(ctx.db, id, { name: "Serra Angel", board: "main", to_board: "maybe" });

    // Serra Angel left the binder; everything else stays where the user put it.
    await importManaBoxCsv(ctx.db, binder());
    const boards = Object.fromEntries(deckDetail(ctx.db, id).cards.map((c) => [`${c.board}:${c.name}`, c.quantity]));
    assert.deepEqual(boards, {
      "commander:Atraxa, Praetors' Voice": 1, "main:Sol Ring": 1, "main:Lightning Bolt": 1, "side:Lightning Bolt": 1,
    });
    assert.equal(listDecks(ctx.db)[0].id, id, "same deck");
  });

  test("fetchCollection batches by 75", async () => {
    const ids = Array.from({ length: 160 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(1000 + i).padStart(12, "0")}` }));
    const res = await fetchCollection(ids);
    assert.deepEqual(stub.calls.map((c) => c.length), [75, 75, 10]);
    assert.equal(res.notFound.length, 160);
  });

  test("fetchCollection keeps /cards/collection at 2 req/s", async () => {
    const ids = Array.from({ length: 160 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(2000 + i).padStart(12, "0")}` }));
    const inner = globalThis.fetch;
    const times = [];
    globalThis.fetch = (url, init) => { times.push(Date.now()); return inner(url, init); };
    try {
      await fetchCollection(ids);
    } finally {
      globalThis.fetch = inner;
    }
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= LIMITED_INTERVAL_MS - 5, `gap ${times[i] - times[i - 1]} ms`);
  });
});
