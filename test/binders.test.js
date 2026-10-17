// Binders (lib/binders.js): the binders table migration, create / rename /
// merge / delete, moving copies between binders, and the collection master
// switch (ManaBox rows moved in the app become source 'app').

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, openDb, migrate } from "../lib/db.js";
import { importManaBoxCsv } from "../lib/manabox.js";
import { searchCollection } from "../lib/query.js";
import {
  BULK_SUGGEST_COPIES, autoBinderType, collectionMaster, createBinder, defaultImportMode, deleteBinder, listBinders, moveCopies, renameBinder,
  setBinderProps, setCollectionMaster,
} from "../lib/binders.js";
import { ID, seedCards, stubScryfall, tempDb } from "./fixtures.js";

let ctx, stub;
beforeEach(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  stub = stubScryfall();
});
afterEach(() => {
  stub.restore();
  ctx.cleanup();
});

/** Insert collection rows: [scryfall_id, qty, {binder, source, finish, condition}]. */
function seed(rows) {
  const stmt = ctx.db.prepare(
    "INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, purchase_price, source) VALUES (?, ?, 'en', ?, ?, ?, ?, ?)",
  );
  for (const [id, qty, o = {}] of rows) stmt.run(id, o.finish ?? "normal", o.condition ?? "near_mint", o.binder ?? "", qty, o.price ?? null, o.source ?? "manabox");
}
const rows = () => ctx.db.prepare("SELECT scryfall_id, binder, source, quantity, finish FROM collection ORDER BY binder, scryfall_id, source, finish").all().map((r) => ({ ...r }));
const summary = () => {
  const l = listBinders(ctx.db);
  return { named: l.binders.map((b) => [b.name, b.copies, b.sources.join("+")]), unsorted: l.unsorted.copies };
};

describe("migration v4", () => {
  test("backfills binders from collection names (case-insensitive) and is idempotent", () => {
    // Simulate a v3 database: no binders table yet, binder names already in use.
    ctx.db.exec("DROP TABLE binders; PRAGMA user_version = 3");
    seed([[ID.sol, 1, { binder: "Trade" }], [ID.lightning, 1, { binder: "trade", source: "scan" }], [ID.serra, 1, { binder: "Box", source: "scan" }], [ID.forest, 2]]);
    migrate(ctx.db);
    const b = () => ctx.db.prepare("SELECT name, origin FROM binders ORDER BY name").all().map((r) => ({ ...r }));
    assert.deepEqual(b(), [{ name: "Box", origin: "app" }, { name: "Trade", origin: "manabox" }]);
    assert.equal(ctx.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    migrate(ctx.db);
    ctx.db.close();
    ctx.db = openDb(ctx.file);
    assert.deepEqual(b(), [{ name: "Box", origin: "app" }, { name: "Trade", origin: "manabox" }]);
    // "Trade" and "trade" are one binder in the list.
    assert.deepEqual(summary(), { named: [["Box", 1, "scan"], ["Trade", 2, "manabox+scan"]], unsorted: 2 });
  });
});

describe("create / list", () => {
  test("empty binders are listed; validation; unsorted bucket separate", () => {
    seed([[ID.sol, 2]]);
    const created = createBinder(ctx.db, "  Trade binder ");
    assert.equal(created.name, "Trade binder");
    assert.ok(created.created_at);
    const l = listBinders(ctx.db);
    assert.deepEqual(l.binders.map((b) => ({ name: b.name, copies: b.copies, empty: b.empty, sources: b.sources })),
      [{ name: "Trade binder", copies: 0, empty: true, sources: [] }]);
    assert.deepEqual({ cards: l.unsorted.cards, copies: l.unsorted.copies, by: l.unsorted.by_source }, { cards: 1, copies: 2, by: { manabox: { cards: 1, copies: 2 } } });
    assert.equal(l.collection_master, "manabox");
    assert.throws(() => createBinder(ctx.db, "trade BINDER"), (e) => e.status === 409);
    assert.throws(() => createBinder(ctx.db, "   "), (e) => e.status === 400);
    assert.throws(() => createBinder(ctx.db, 42), (e) => e.status === 400);
    assert.throws(() => createBinder(ctx.db, "x".repeat(101)), (e) => e.status === 400);
    // A name only used in the collection also exists.
    seed([[ID.serra, 1, { binder: "Box" }]]);
    assert.throws(() => createBinder(ctx.db, "box"), (e) => e.status === 409);
  });
});

describe("move", () => {
  test("partial move splits a row, merges into the target, keeps scan rows as scan", () => {
    seed([[ID.lightning, 4, { binder: "A", source: "scan", price: 1.5 }], [ID.lightning, 1, { binder: "B", source: "scan" }]]);
    const r = moveCopies(ctx.db, { items: [{ scryfall_id: ID.lightning, binder: "A", quantity: 3 }], to_binder: "b" });
    assert.equal(r.moved_copies, 3);
    assert.equal(r.converted_copies, 0);
    assert.equal(r.to_binder, "B", "existing binder's spelling");
    assert.deepEqual(rows(), [
      { scryfall_id: ID.lightning, binder: "A", source: "scan", quantity: 1, finish: "normal" },
      { scryfall_id: ID.lightning, binder: "B", source: "scan", quantity: 4, finish: "normal" },
    ]);
    // The rest, into Unsorted.
    moveCopies(ctx.db, { items: [{ scryfall_id: ID.lightning, binder: "A", quantity: 1 }], to_binder: "" });
    assert.deepEqual(summary(), { named: [["A", 0, ""], ["B", 4, "scan"]], unsorted: 1 });
  });

  test("validation: quantity, availability, unknown target, missing rows", () => {
    seed([[ID.sol, 2, { binder: "A", source: "scan" }]]);
    const mv = (body) => () => moveCopies(ctx.db, body);
    assert.throws(mv({ items: [], to_binder: "A" }), (e) => e.status === 400);
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "A", quantity: 0 }], to_binder: "" }), (e) => e.status === 400);
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "A", quantity: 3 }], to_binder: "" }), (e) => e.status === 409);
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "A", quantity: 1 }, { scryfall_id: ID.sol, binder: "A", quantity: 2 }], to_binder: "" }),
      (e) => e.status === 409, "two items can't take the same copies");
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "Nope", quantity: 1 }], to_binder: "" }), (e) => e.status === 404);
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "A", quantity: 1 }], to_binder: "New" }), (e) => e.status === 404);
    assert.throws(mv({ items: [{ scryfall_id: ID.sol, binder: "A", quantity: 1 }] }), (e) => e.status === 400, "to_binder required");
    assert.throws(mv({ items: [{ oracle_id: "o-nothing" }], to_binder: "" }), (e) => e.status === 404);
    const r = moveCopies(ctx.db, { items: [{ scryfall_id: ID.sol, binder: "A", quantity: 1 }], to_binder: "New", create: true });
    assert.equal(r.created, true);
    assert.deepEqual(summary().named, [["A", 1, "scan"], ["New", 1, "scan"]]);
  });

  test("bulk: whole oracle cards (all printings), optionally only from one binder", () => {
    seed([
      [ID.counterspell, 1, { binder: "A", source: "scan" }], [ID.counterspell7ed, 2, { binder: "B", source: "scan" }],
      [ID.sol, 1, { binder: "A", source: "scan" }], [ID.sol, 1, { source: "scan", finish: "foil" }],
    ]);
    moveCopies(ctx.db, { items: [{ oracle_id: "o-counter" }, { oracle_id: "o-solring", from_binder: "a" }], to_binder: "Blue", create: true });
    assert.deepEqual(rows(), [
      { scryfall_id: ID.sol, binder: "", source: "scan", quantity: 1, finish: "foil" },
      { scryfall_id: ID.sol, binder: "Blue", source: "scan", quantity: 1, finish: "normal" },
      { scryfall_id: ID.counterspell, binder: "Blue", source: "scan", quantity: 1, finish: "normal" },
      { scryfall_id: ID.counterspell7ed, binder: "Blue", source: "scan", quantity: 2, finish: "normal" },
    ]);
    // A whole printing (every finish / binder of it).
    moveCopies(ctx.db, { items: [{ printing_id: ID.sol }], to_binder: "" });
    assert.deepEqual(rows().filter((r) => r.scryfall_id === ID.sol).map((r) => [r.binder, r.quantity, r.finish]), [["", 1, "foil"], ["", 1, "normal"]]);
    moveCopies(ctx.db, { items: [{ printing_id: ID.sol, from_binder: "" }], to_binder: "Blue" });
    // Copies already in the target stay; nothing else changes.
    const r = moveCopies(ctx.db, { items: [{ oracle_id: "o-counter" }], to_binder: "Blue" });
    assert.equal(r.moved_copies, 0);
    // The collection list can filter by exact binder ('' = Unsorted).
    assert.deepEqual(searchCollection(ctx.db, { binder: "" }).rows.map((x) => x.name), []);
    assert.deepEqual(searchCollection(ctx.db, { binder: "blue" }).rows.map((x) => [x.name, x.qty]), [["Counterspell", 3], ["Sol Ring", 2]]);
  });

  test("ManaBox rows: confirmation once, then moved copies become 'app' and the master flips", () => {
    seed([[ID.sol, 3, { binder: "Box", price: 2 }], [ID.sol, 1, { binder: "Trade", source: "app" }]]);
    const body = { items: [{ scryfall_id: ID.sol, binder: "Box", quantity: 2 }], to_binder: "Trade" };
    assert.throws(() => moveCopies(ctx.db, body), (e) => e.status === 409 && e.extra.code === "confirm_master" && e.extra.manabox_copies === 2);
    assert.equal(collectionMaster(ctx.db), "manabox");
    assert.equal(rows().find((r) => r.binder === "Box").quantity, 3, "nothing moved without confirmation");
    const r = moveCopies(ctx.db, { ...body, confirm_master: true });
    assert.deepEqual([r.moved_copies, r.converted_copies, r.collection_master], [2, 2, "app"]);
    assert.deepEqual(rows(), [
      { scryfall_id: ID.sol, binder: "Box", source: "manabox", quantity: 1, finish: "normal" },
      { scryfall_id: ID.sol, binder: "Trade", source: "app", quantity: 3, finish: "normal" },
    ]);
    assert.equal(ctx.db.prepare("SELECT purchase_price FROM collection WHERE binder = 'Trade'").get().purchase_price, 2, "purchase price carried over");
    // Master is 'app' now: no more confirmation needed.
    moveCopies(ctx.db, { items: [{ scryfall_id: ID.sol, binder: "Box", quantity: 1 }], to_binder: "" });
    assert.equal(defaultImportMode(ctx.db), "delta");
    assert.throws(() => setCollectionMaster(ctx.db, "other"), (e) => e.status === 400);
    setCollectionMaster(ctx.db, "manabox");
    assert.equal(defaultImportMode(ctx.db), "replace");
  });
});

describe("rename / delete", () => {
  test("rename moves every source, merges into an existing binder, renames a scan deck", () => {
    seed([
      [ID.sol, 2, { binder: "Old", source: "scan" }], [ID.lightning, 1, { binder: "Old", source: "manabox" }],
      [ID.sol, 1, { binder: "Main", source: "scan" }],
    ]);
    ctx.db.prepare("INSERT INTO decks (name, source) VALUES ('Old', 'scan')").run();
    assert.throws(() => renameBinder(ctx.db, "Old", "Main"), (e) => e.status === 409 && e.extra.code === "confirm_master");
    const r = renameBinder(ctx.db, "old", "main", { confirm_master: true });
    assert.deepEqual([r.name, r.merged, r.renamed, r.converted_copies, r.collection_master], ["Main", true, 3, 1, "app"]);
    assert.deepEqual(rows(), [
      { scryfall_id: ID.sol, binder: "Main", source: "scan", quantity: 3, finish: "normal" },
      { scryfall_id: ID.lightning, binder: "Main", source: "app", quantity: 1, finish: "normal" },
    ]);
    assert.deepEqual(summary().named, [["Main", 4, "app+scan"]]);
    assert.deepEqual(ctx.db.prepare("SELECT name FROM decks").all().map((d) => d.name), ["Main"], "the scan deck of the binder follows");
    // Plain rename (and case-only rename) of an empty binder.
    createBinder(ctx.db, "empty");
    renameBinder(ctx.db, "empty", "Empty");
    assert.deepEqual(summary().named, [["Empty", 0, ""], ["Main", 4, "app+scan"]]);
    assert.throws(() => renameBinder(ctx.db, "Nope", "X"), (e) => e.status === 404);
    assert.throws(() => renameBinder(ctx.db, "Main", " "), (e) => e.status === 400);
  });

  test("delete: unsort (default) vs delete; ManaBox rows never silently deleted", () => {
    seed([[ID.sol, 2, { binder: "A", source: "scan" }], [ID.lightning, 1, { binder: "A" }], [ID.serra, 1, { binder: "S", source: "scan" }]]);
    assert.throws(() => deleteBinder(ctx.db, "A", { cards: "delete" }), (e) => e.status === 409 && e.extra.code === "manabox_rows");
    assert.throws(() => deleteBinder(ctx.db, "A"), (e) => e.status === 409 && e.extra.code === "confirm_master", "unsort moves ManaBox rows too");
    assert.throws(() => deleteBinder(ctx.db, "A", { cards: "burn" }), (e) => e.status === 400);
    assert.throws(() => deleteBinder(ctx.db, "Nope"), (e) => e.status === 404);
    const d = deleteBinder(ctx.db, "S", { cards: "delete" });
    assert.equal(d.deleted_copies, 1);
    const u = deleteBinder(ctx.db, "A", { confirm_master: true });
    assert.deepEqual([u.unsorted_copies, u.converted_copies, u.collection_master], [3, 1, "app"]);
    assert.deepEqual(summary(), { named: [], unsorted: 3 });
    // With the app as master, ManaBox rows may be deleted with their binder.
    seed([[ID.atraxa, 1, { binder: "M" }]]);
    assert.equal(deleteBinder(ctx.db, "M", { cards: "delete" }).deleted_copies, 1);
    // The legacy unlogged delete by source is gone: 400, nothing deleted.
    seed([[ID.forest, 1, { binder: "L", source: "scan" }], [ID.forest, 1, { binder: "L" }]]);
    assert.throws(() => deleteBinder(ctx.db, "L", { source: "scan" }), (e) => e.status === 400);
    assert.throws(() => deleteBinder(ctx.db, "L", { source: "manabox" }), (e) => e.status === 400);
    assert.equal(ctx.db.prepare("SELECT SUM(quantity) AS n FROM collection WHERE binder = 'L'").get().n, 2);
  });

  test("delete cards with confirm_master flips the master to the app (like POST /api/collection/delete)", () => {
    seed([[ID.sol, 2, { binder: "A" }]]);
    const r = deleteBinder(ctx.db, "A", { cards: "delete", confirm_master: true });
    assert.deepEqual([r.deleted_copies, r.collection_master], [2, "app"]);
    assert.deepEqual(summary(), { named: [], unsorted: 0 });
  });
});

describe("ManaBox import and the master setting", () => {
  const HEADER = "Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Language,Condition";
  const csv = (...lines) => [HEADER, ...lines].join("\n") + "\n";
  const line = (binder, name, set, num, qty, id) => `${binder},binder,"${name}",${set},${num},normal,${qty},${id},en,near_mint`;

  test("binders seen in an import are registered; replace prunes emptied ManaBox binders but keeps app binders", async () => {
    await importManaBoxCsv(ctx.db, csv(line("Box", "Sol Ring", "c21", "263", 2, ID.sol), line("Old", "Serra Angel", "dmu", "33", 1, ID.serra)));
    createBinder(ctx.db, "Mine");
    assert.deepEqual(listBinders(ctx.db).binders.map((b) => b.name), ["Box", "Mine", "Old"]);
    await importManaBoxCsv(ctx.db, csv(line("Box", "Sol Ring", "c21", "263", 2, ID.sol)), { mode: "replace" });
    assert.deepEqual(listBinders(ctx.db).binders.map((b) => b.name), ["Box", "Mine"]);
  });

  test("with the app as master the import defaults to delta; replace still only deletes ManaBox rows", async () => {
    const file = csv(line("Box", "Sol Ring", "c21", "263", 2, ID.sol), line("Box", "Lightning Bolt", "m10", "146", 1, ID.lightning));
    await importManaBoxCsv(ctx.db, file);
    assert.equal(ctx.db.prepare("SELECT mode FROM imports ORDER BY id DESC").get().mode, "replace", "default while ManaBox is master");
    moveCopies(ctx.db, { items: [{ scryfall_id: ID.sol, binder: "Box", quantity: 2 }], to_binder: "Mine", create: true, confirm_master: true });
    assert.equal(collectionMaster(ctx.db), "app");
    const s = await importManaBoxCsv(ctx.db, file);
    assert.equal(s.mode, "delta");
    assert.deepEqual([s.added_copies, s.decreased_copies], [0, 0], "the moved copies are not re-added");
    assert.deepEqual(rows(), [
      { scryfall_id: ID.lightning, binder: "Box", source: "manabox", quantity: 1, finish: "normal" },
      { scryfall_id: ID.sol, binder: "Mine", source: "app", quantity: 2, finish: "normal" },
    ]);
    const r = await importManaBoxCsv(ctx.db, file, { mode: "replace" });
    assert.equal(r.mode, "replace");
    assert.equal(r.kept_app_copies, 2);
    assert.deepEqual(summary().named, [["Box", 1, "manabox"], ["Mine", 2, "app"]], "app rows survive an explicit replace and are not loaded twice");
  });
});

describe("types and covers (migration v14)", () => {
  const entry = (name) => listBinders(ctx.db).binders.find((b) => b.name === name);

  test("v13 -> v14 adds binders.type / cover_scryfall_id (NULL = auto), keeps rows, idempotent", () => {
    seed([[ID.sol, 2, { binder: "Trade" }]]);
    createBinder(ctx.db, "Empty");
    ctx.db.exec("ALTER TABLE binders DROP COLUMN type; ALTER TABLE binders DROP COLUMN cover_scryfall_id; PRAGMA user_version = 13");
    migrate(ctx.db);
    assert.equal(ctx.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    const cols = ctx.db.prepare("PRAGMA table_info(binders)").all().map((c) => c.name);
    assert.deepEqual(cols, ["name", "origin", "created_at", "type", "cover_scryfall_id"]);
    assert.deepEqual(ctx.db.prepare("SELECT name, type, cover_scryfall_id FROM binders ORDER BY name").all().map((r) => ({ ...r })),
      [{ name: "Empty", type: null, cover_scryfall_id: null }]);
    ctx.db.exec("PRAGMA user_version = 13");
    migrate(ctx.db);
    assert.equal(entry("Trade").copies, 2);
  });

  test("auto type: deck-box names and binders linked to decks; big binders only suggested as bulk", () => {
    assert.equal(autoBinderType("Deck box: Elves"), "deck_box");
    assert.equal(autoBinderType("Commander Deck: Rin and Seri"), "deck_box");
    assert.equal(autoBinderType("Foundation Commander: X"), "deck_box");
    assert.equal(autoBinderType("Pauper: Mono White"), "binder");
    assert.equal(autoBinderType("Trade"), "binder");
    assert.equal(autoBinderType("Elves", true), "deck_box");
    seed([[ID.sol, 1, { binder: "Shelf" }], [ID.serra, BULK_SUGGEST_COPIES + 1, { binder: "Pile" }], [ID.forest, 1, { binder: "Deck box: Elves" }]]);
    ctx.db.prepare("INSERT INTO decks (name, source, status, box_binder) VALUES ('Elves', 'manual', 'built', 'shelf')").run();
    const shelf = entry("Shelf");
    assert.deepEqual([shelf.type, shelf.type_auto, shelf.type_set], ["deck_box", "deck_box", false]);
    assert.deepEqual(shelf.decks, [{ id: 1, name: "Elves", status: "built" }]);
    assert.equal(entry("Deck box: Elves").type, "deck_box");
    const pile = entry("Pile");
    assert.deepEqual([pile.type, pile.type_suggest], ["binder", "bulk"]);
    setBinderProps(ctx.db, "pile", { type: "binder" });
    assert.deepEqual([entry("Pile").type_set, entry("Pile").type_suggest], [true, null], "answering keeps it from asking again");
    setBinderProps(ctx.db, "Pile", { type: "bulk" });
    assert.equal(entry("Pile").type, "bulk");
    assert.throws(() => setBinderProps(ctx.db, "Pile", { type: "box" }), (e) => e.status === 400);
    assert.throws(() => setBinderProps(ctx.db, "Pile", {}), (e) => e.status === 400);
    assert.throws(() => setBinderProps(ctx.db, "Nope", { type: "bulk" }), (e) => e.status === 404);
  });

  test("value and cover: most valuable card unless chosen; a chosen cover that left the binder falls back", () => {
    seed([[ID.sol, 2, { binder: "A", source: "scan" }], [ID.atraxa, 1, { binder: "A", source: "scan" }], [ID.lightning, 1, { binder: "A", source: "scan", finish: "foil" }]]);
    let a = entry("A");
    assert.equal(a.value_eur, 2 * 1.5 + 20 + 5);
    assert.deepEqual([a.top.name, a.top.price_eur, a.cover.scryfall_id, a.cover.chosen], ["Atraxa, Praetors' Voice", 20, ID.atraxa, false]);
    setBinderProps(ctx.db, "A", { cover_scryfall_id: ID.sol });
    a = entry("A");
    assert.deepEqual([a.cover.scryfall_id, a.cover.chosen], [ID.sol, true]);
    assert.throws(() => setBinderProps(ctx.db, "A", { cover_scryfall_id: ID.serra }), (e) => e.status === 400);
    moveCopies(ctx.db, { items: [{ printing_id: ID.sol }], to_binder: "B", create: true });
    assert.deepEqual([entry("A").cover.scryfall_id, entry("A").cover.chosen], [ID.atraxa, false]);
    setBinderProps(ctx.db, "A", { cover_scryfall_id: null });
    assert.equal(ctx.db.prepare("SELECT cover_scryfall_id FROM binders WHERE name = 'A'").get().cover_scryfall_id, null);
  });

  test("rename carries type and cover; a merge keeps the target's", () => {
    seed([[ID.sol, 1, { binder: "A", source: "scan" }], [ID.serra, 1, { binder: "B", source: "scan" }]]);
    setBinderProps(ctx.db, "A", { type: "trade", cover_scryfall_id: ID.sol });
    renameBinder(ctx.db, "A", "Trades");
    assert.deepEqual([entry("Trades").type, entry("Trades").cover.chosen], ["trade", true]);
    setBinderProps(ctx.db, "B", { type: "other" });
    renameBinder(ctx.db, "Trades", "B");
    const b = entry("B");
    assert.deepEqual([b.type, b.cover.scryfall_id, b.cover.chosen], ["other", ID.sol, true], "B had no cover: the merged one's comes along");
  });
});
