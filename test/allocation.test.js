// Deck allocation (idea/built decks claim copies), the ManaBox delta import
// with its snapshot, migrations v5/v6 from a v4 database, the avail:/used:
// search keys and "Put into deck box" (Scryfall is stubbed; no network).

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../lib/db.js";
import {
  allocation, cardUsage, deckDetail, deckToText, listDecks, saveDeck, saveDeckRows, setDeckStatus, shoppingList,
} from "../lib/decks.js";
import { collectionMaster, deckToBinder, defaultImportMode, listBinders, moveCopies, renameBinder, setCollectionMaster } from "../lib/binders.js";
import { importManaBoxCsv } from "../lib/manabox.js";
import { searchCollection } from "../lib/query.js";
import { ID, seedCards, stubScryfall, tempDb } from "./fixtures.js";

let ctx;
beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); });
afterEach(() => ctx.cleanup());

/** rows of [scryfall_id, quantity, {binder, source, finish}] */
function seed(rows) {
  const stmt = ctx.db.prepare(
    "INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, ?, 'en', 'near_mint', ?, ?, ?)",
  );
  for (const [id, qty, o = {}] of rows) stmt.run(id, o.finish ?? "normal", o.binder ?? "", qty, o.source ?? "manabox");
}
const row = (name, id, quantity, board = "main") => ({ name, scryfall_id: id, quantity, board });
const deck = (name, status, rows) => saveDeckRows(ctx.db, { name, status, rows });
const pick = (detail, name, board = "main") => detail.cards.find((c) => c.name === name && c.board === board);

describe("migrations v5/v6 from a v4 database", () => {
  test("snapshot backfilled from ManaBox rows, deck status added (manabox = built), idempotent", () => {
    seed([
      [ID.sol, 2, { binder: "Box" }], [ID.sol, 1, { binder: "box" }], [ID.lightning, 1, { binder: "Mine", source: "app" }],
      [ID.serra, 3, { binder: "", source: "scan" }], [ID.forest, 4],
    ]);
    ctx.db.prepare("INSERT INTO decks (name, source) VALUES ('Synced', 'manabox'), ('Plan', 'manual')").run();
    // Downgrade to the v4 schema: no snapshot table, no decks.status.
    ctx.db.exec("DROP TABLE manabox_snapshot; ALTER TABLE decks DROP COLUMN status; PRAGMA user_version = 4");
    ctx.db.close();
    const raw = new DatabaseSync(ctx.file);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 4);
    raw.close();

    for (let i = 0; i < 2; i++) {
      const db = openDb(ctx.file);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
      const snap = db.prepare("SELECT scryfall_id, lower(binder) AS b, quantity FROM manabox_snapshot ORDER BY scryfall_id, b").all().map((r) => ({ ...r }));
      assert.deepEqual(snap, [
        { scryfall_id: ID.sol, b: "box", quantity: 3 },
        { scryfall_id: ID.forest, b: "", quantity: 4 },
      ], "only source=manabox rows, binder names case-insensitive");
      assert.deepEqual(db.prepare("SELECT name, status FROM decks ORDER BY id").all().map((r) => [r.name, r.status]), [["Synced", "built"], ["Plan", "idea"]]);
      // Re-running the migrations must not duplicate or reset anything.
      db.exec("PRAGMA user_version = 4");
      db.prepare("UPDATE decks SET status = 'built' WHERE name = 'Plan'").run();
      db.close();
      const again = openDb(ctx.file);
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM manabox_snapshot").get().n, 2);
      assert.equal(again.prepare("SELECT status FROM decks WHERE name = 'Plan'").get().status, "built", "status kept on re-run");
      again.prepare("UPDATE decks SET status = 'idea' WHERE name = 'Plan'").run();
      again.close();
    }
    ctx.db = openDb(ctx.file);
  });
});

describe("allocation", () => {
  // Owned: Sol 1, Counterspell 2 (two printings), Forest 5, Bolt 1, Serra 2; Atraxa 0.
  // A (built): Atraxa cmdr, Sol, Counterspell, 10 Forest, Serra maybe. B (built): Sol, Counterspell (side), Bolt.
  // C (idea): Sol, 2 Counterspell, Bolt.
  let A, B, C;
  beforeEach(() => {
    seed([
      [ID.sol, 1], [ID.counterspell, 1, { binder: "Trade", source: "scan" }], [ID.counterspell7ed, 1, { source: "scan" }],
      [ID.forest, 5], [ID.lightning, 1, { binder: "Deck box: B", source: "app" }], [ID.serra, 2, { binder: "Trade", source: "scan" }],
    ]);
    A = deck("A", "built", [row("Atraxa, Praetors' Voice", ID.atraxa, 1, "commander"), row("Sol Ring", ID.sol, 1),
      row("Counterspell", ID.counterspell, 1), row("Forest", ID.forest, 10), row("Serra Angel", ID.serra, 1, "maybe")]);
    B = deck("B", "built", [row("Sol Ring", ID.sol, 1), row("Counterspell", ID.counterspell7ed, 1, "side"), row("Lightning Bolt", ID.lightning, 1)]);
    C = deck("C", "idea", [row("Sol Ring", ID.sol, 1), row("Counterspell", ID.counterspell, 2), row("Lightning Bolt", ID.lightning, 1)]);
  });

  test("built deck: used elsewhere, free copies, conflicts, missing and its shopping list", () => {
    const a = deckDetail(ctx.db, A);
    assert.equal(a.status, "built");
    const sol = pick(a, "Sol Ring");
    assert.deepEqual([sol.owned, sol.available_for_this, sol.missing, sol.conflict], [1, 0, 1, true]);
    assert.deepEqual(sol.used_elsewhere, [{ deck_id: B, name: "B", status: "built", quantity: 1 }]);
    const counter = pick(a, "Counterspell");
    assert.deepEqual([counter.owned, counter.available_for_this, counter.missing, counter.conflict], [2, 1, 0, false], "2 owned, 2 claimed: fine");
    const forest = pick(a, "Forest");
    assert.deepEqual([forest.basic, forest.missing, forest.conflict], [true, 0, false], "basics never conflict or go missing");
    const atraxa = pick(a, "Atraxa, Praetors' Voice", "commander");
    assert.deepEqual([atraxa.owned, atraxa.missing, atraxa.conflict], [0, 1, false], "short but no other deck involved: missing, not a conflict");
    assert.equal(pick(a, "Serra Angel", "maybe").missing, 0, "2 owned, nobody claims them");
    assert.equal(a.conflict_count, 1);
    assert.deepEqual(a.conflicts.map((c) => [c.name, c.owned, c.demand, c.decks.map((d) => d.name)]), [["Sol Ring", 1, 2, ["A", "B"]]]);
    assert.equal(a.missing_count, 2);
    assert.deepEqual(a.shopping.items.map((i) => [i.name, i.need, i.price_eur, i.cost_eur]), [
      ["Atraxa, Praetors' Voice", 1, 20, 20], ["Sol Ring", 1, 1.5, 1.5],
    ]);
    assert.equal(a.shopping.total_eur, 21.5);
    assert.equal(a.shopping.total_eur, a.missing_cost_eur);
    const text = deckToText(a);
    assert.match(text, /status: BUILT/);
    assert.match(text, /Conflicts \(1/);
    assert.match(text, /Sol Ring .*MISSING 1 \(owned 1, free 0\), also in B CONFLICT/);
  });

  test("idea deck claims nothing but only counts free copies", () => {
    const c = deckDetail(ctx.db, C);
    assert.equal(c.status, "idea");
    assert.deepEqual([pick(c, "Sol Ring").available_for_this, pick(c, "Sol Ring").missing], [-1, 1]);
    assert.deepEqual([pick(c, "Counterspell").owned, pick(c, "Counterspell").available_for_this, pick(c, "Counterspell").missing], [2, 0, 2]);
    assert.equal(pick(c, "Lightning Bolt").missing, 1, "the only Bolt sits in built deck B");
    assert.equal(c.conflict_count, 0, "an idea deck never conflicts");
    assert.equal(c.missing_count, 4);
    // Ideas don't take copies away from anyone.
    assert.equal(pick(deckDetail(ctx.db, B), "Lightning Bolt").missing, 0);
  });

  test("listDecks, shoppingList, cardUsage; status changes move the claims", () => {
    const list = Object.fromEntries(listDecks(ctx.db).map((d) => [d.name, [d.status, d.conflict_count, d.missing_count]]));
    assert.deepEqual(list, { A: ["built", 1, 2], B: ["built", 1, 1], C: ["idea", 0, 4] });
    const shop = shoppingList(ctx.db);
    assert.deepEqual(shop.built.items.map((i) => [i.name, i.short, i.price_eur, i.decks.map((d) => d.name)]), [
      ["Atraxa, Praetors' Voice", 1, 20, ["A"]], ["Sol Ring", 1, 1.5, ["A", "B"]],
    ], "basics never on the list");
    assert.equal(shop.built.total_eur, 21.5);
    assert.deepEqual(shop.per_deck.map((d) => [d.name, d.status, d.missing_count]), [["A", "built", 2], ["B", "built", 1], ["C", "idea", 4]]);
    const usage = cardUsage(ctx.db, { oracle_id: "o-solring", name: "Sol Ring" });
    assert.deepEqual([usage.owned, usage.built_demand, usage.available], [1, 2, -1]);
    assert.deepEqual(usage.decks.map((d) => [d.name, d.status, d.board, d.quantity]), [["A", "built", "main", 1], ["B", "built", "main", 1], ["C", "idea", "main", 1]]);

    assert.throws(() => setDeckStatus(ctx.db, B, "done"), (e) => e.status === 400);
    assert.throws(() => setDeckStatus(ctx.db, 999, "idea"), (e) => e.status === 404);
    assert.equal(setDeckStatus(ctx.db, B, "idea").status, "idea");
    assert.equal(deckDetail(ctx.db, A).conflict_count, 0);
    assert.equal(allocation(ctx.db).built.get("o-solring").demand, 1);
    assert.equal(shoppingList(ctx.db).built.items.length, 1);
  });

  test("search: avail and used keys, rows carry avail/used", () => {
    const names = (q) => searchCollection(ctx.db, { q }).rows.map((r) => r.name);
    assert.deepEqual(names("avail>=1"), ["Forest", "Serra Angel"], "basic lands are always free");
    assert.deepEqual(names("avail<0"), ["Sol Ring"]);
    assert.deepEqual(names("used>=1"), ["Counterspell", "Forest", "Lightning Bolt", "Sol Ring"]);
    assert.deepEqual(names("is:used"), names("used>=1"));
    assert.deepEqual(names("used:no"), ["Serra Angel"]);
    assert.deepEqual(names("-used>=1"), ["Serra Angel"]);
    assert.deepEqual(names("used:yes t:instant"), ["Counterspell", "Lightning Bolt"]);
    const counter = searchCollection(ctx.db, { q: "counterspell" }).rows[0];
    assert.deepEqual([counter.qty, counter.used, counter.avail], [2, 2, 0]);
    assert.throws(() => searchCollection(ctx.db, { q: "avail>x" }), /Not a number/);
  });

  test("put into deck box: Unsorted first, never another built deck's box, contested copies to the first built deck", () => {
    // B's one Sol Ring is a ManaBox copy -> confirm first.
    assert.throws(() => deckToBinder(ctx.db, B), (e) => e.status === 409 && e.extra.code === "confirm_master");
    const b = deckToBinder(ctx.db, B, { confirm_master: true });
    assert.equal(b.binder, "Deck box: B");
    assert.deepEqual(b.moved.map((m) => [m.name, m.quantity, m.from.map((f) => f.binder)]), [["Sol Ring", 1, [""]], ["Counterspell", 1, [""]]],
      "7ed copy from Unsorted, Trade copy stays; the contested Sol Ring goes to the first built deck boxed");
    assert.deepEqual(b.missing, []);
    assert.equal(b.collection_master, "app");

    // A: the Counterspell and Sol Ring now in B's box are protected.
    const a = deckToBinder(ctx.db, A);
    assert.equal(a.binder, "Deck box: A");
    assert.equal(a.created, true);
    assert.deepEqual(a.moved.map((m) => [m.name, m.quantity, m.from.map((f) => f.binder)]), [["Forest", 5, [""]], ["Counterspell", 1, ["Trade"]]]);
    assert.deepEqual(a.missing, [{ name: "Atraxa, Praetors' Voice", quantity: 1 }, { name: "Sol Ring", quantity: 1 }], "basics never missing");
    const boxes = Object.fromEntries(listBinders(ctx.db).binders.map((x) => [x.name, x.copies]));
    assert.equal(boxes["Deck box: A"], 6);
    assert.equal(boxes["Deck box: B"], 3);
    // Running it again moves nothing more.
    const again = deckToBinder(ctx.db, A);
    assert.deepEqual([again.moved_copies, again.moved.length], [0, 0]);
    // A custom binder name works; unknown decks 404.
    const named = deckToBinder(ctx.db, C, { binder: "Idea pile" });
    assert.equal(named.binder, "Idea pile");
    assert.throws(() => deckToBinder(ctx.db, 999), (e) => e.status === 404);
  });

  test("saveDeck: new decks are ideas by default, status kept on update, manabox decks built", async () => {
    const stub = stubScryfall();
    try {
      const s = await saveDeck(ctx.db, { name: "New", source: "claude", items: [{ name: "Sol Ring", quantity: 1 }] });
      assert.equal(deckDetail(ctx.db, s.id).status, "idea");
      setDeckStatus(ctx.db, s.id, "built");
      await saveDeck(ctx.db, { id: s.id, name: "New", items: [{ name: "Sol Ring", quantity: 1 }] });
      assert.equal(deckDetail(ctx.db, s.id).status, "built", "kept");
      const b = await saveDeck(ctx.db, { name: "Built", status: "built", items: [{ name: "Sol Ring", quantity: 1 }] });
      assert.equal(deckDetail(ctx.db, b.id).status, "built");
      await assert.rejects(saveDeck(ctx.db, { name: "X", status: "maybe", items: [{ name: "Sol Ring" }] }), (e) => e.status === 400);
      const m = saveDeckRows(ctx.db, { name: "Synced", source: "manabox", rows: [] });
      assert.equal(deckDetail(ctx.db, m).status, "built");
    } finally { stub.restore(); }
  });
});

describe("ManaBox delta import", () => {
  const HEADER = "Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Language,Condition";
  const csv = (...lines) => [HEADER, ...lines].join("\n") + "\n";
  const line = (binder, name, set, num, qty, id, type = "binder") => `${binder},${type},"${name}",${set},${num},normal,${qty},${id},en,near_mint`;
  const coll = () => ctx.db.prepare("SELECT scryfall_id, binder, source, quantity FROM collection ORDER BY binder, scryfall_id, source").all()
    .map((r) => [r.binder, r.scryfall_id, r.source, r.quantity]);
  const snap = () => ctx.db.prepare("SELECT scryfall_id, binder, quantity FROM manabox_snapshot ORDER BY binder, scryfall_id").all()
    .map((r) => [r.binder, r.scryfall_id, r.quantity]);
  let stub;
  beforeEach(() => { stub = stubScryfall(); });
  afterEach(() => stub.restore());

  test("adds only increases, reports decreases, re-import is a no-op, every mode rewrites the snapshot", async () => {
    const file1 = csv(line("Box", "Sol Ring", "c21", "263", 2, ID.sol), line("Box", "Lightning Bolt", "m10", "146", 1, ID.lightning),
      line("DeckX", "Counterspell", "mh2", "267", 1, ID.counterspell, "deck"));
    await importManaBoxCsv(ctx.db, file1, { mode: "replace" });
    assert.deepEqual(snap(), [["Box", ID.sol, 2], ["Box", ID.lightning, 1], ["DeckX", ID.counterspell, 1]]);
    assert.equal(ctx.db.prepare("SELECT status FROM decks WHERE name = 'DeckX'").get().status, "built", "binder decks are built");

    moveCopies(ctx.db, { items: [{ scryfall_id: ID.sol, binder: "Box", quantity: 2 }], to_binder: "Mine", create: true, confirm_master: true });
    assert.equal(collectionMaster(ctx.db), "app");
    assert.equal(defaultImportMode(ctx.db), "delta");
    const before = coll();
    const same = await importManaBoxCsv(ctx.db, file1);
    assert.equal(same.mode, "delta");
    assert.deepEqual([same.added, same.decreased, same.added_copies, same.decreased_copies], [[], [], 0, 0]);
    assert.deepEqual(coll(), before, "the same export changes nothing");
    assert.equal(ctx.db.prepare("SELECT SUM(quantity) AS n FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.name = 'DeckX'").get().n, 1, "deck not duplicated");

    // ManaBox gained a Sol Ring and two Serra Angels in a new binder, and lost the Bolt.
    const file2 = csv(line("Box", "Sol Ring", "c21", "263", 3, ID.sol), line("new", "Serra Angel", "dmu", "33", 1, ID.serra),
      line("New", "Serra Angel", "dmu", "33", 1, ID.serra), line("DeckX", "Counterspell", "mh2", "267", 1, ID.counterspell, "deck"));
    const d = await importManaBoxCsv(ctx.db, file2);
    assert.deepEqual(d.added.map((a) => [a.name, a.binder, a.quantity]), [["Sol Ring", "Box", 1], ["Serra Angel", "new", 2]]);
    assert.equal(d.added_copies, 3);
    assert.deepEqual(d.binders_created, ["new"]);
    assert.deepEqual(d.decreased.map((x) => [x.name, x.binder, x.before, x.after, x.quantity, x.message]), [
      ["Lightning Bolt", "Box", 1, 0, -1, "ManaBox has fewer copies of Lightning Bolt (−1)"],
    ]);
    assert.deepEqual(coll(), [
      ["Box", ID.sol, "manabox", 1], ["Box", ID.lightning, "manabox", 1], ["DeckX", ID.counterspell, "manabox", 1],
      ["Mine", ID.sol, "app", 2], ["new", ID.serra, "manabox", 2],
    ], "the Bolt is not deleted");
    assert.equal(ctx.db.prepare("SELECT origin FROM binders WHERE name = 'new'").get().origin, "manabox");
    assert.deepEqual(snap().length, 3);

    const again = await importManaBoxCsv(ctx.db, file2);
    assert.deepEqual([again.added_copies, again.decreased_copies], [0, 0]);

    // "add" duplicates, but also rewrites the snapshot: a following delta adds nothing.
    const add = await importManaBoxCsv(ctx.db, file2, { mode: "add" });
    assert.equal(add.mode, "add");
    assert.equal(ctx.db.prepare("SELECT quantity FROM collection WHERE binder = 'Box' AND scryfall_id = ?").get(ID.sol).quantity, 4);
    assert.equal((await importManaBoxCsv(ctx.db, file2)).added_copies, 0);
    await assert.rejects(importManaBoxCsv(ctx.db, file2, { mode: "merge" }), /replace", "delta" or "add/);
    await assert.rejects(importManaBoxCsv(ctx.db, csv(line("X", "Nope", "zzz", "1", 1, ""))), /Nothing importable/, "a delta never resets the snapshot to nothing");
    assert.equal(snap().length, 3);
  });
});

describe("review fixes: renames, deck boxes, replace netting, basics", () => {
  const HEADER = "Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Language,Condition";
  const csv = (...lines) => [HEADER, ...lines].join("\n") + "\n";
  const line = (binder, name, set, num, qty, id, type = "binder") => `${binder},${type},"${name}",${set},${num},normal,${qty},${id},en,near_mint`;
  const solTotal = () => ctx.db.prepare("SELECT SUM(quantity) AS n FROM collection WHERE scryfall_id = ?").get(ID.sol).n;
  const where = (id) => ctx.db.prepare("SELECT binder, SUM(quantity) AS q FROM collection WHERE scryfall_id = ? GROUP BY binder ORDER BY binder").all(id)
    .map((r) => [r.binder, r.q]);
  let stub;
  beforeEach(() => { stub = stubScryfall(); });
  afterEach(() => stub.restore());

  test("case-only rename of a binder with rows under two spellings keeps every copy", () => {
    seed([[ID.sol, 3, { binder: "Trade", source: "scan" }], [ID.sol, 2, { binder: "trade", source: "scan" }]]);
    ctx.db.prepare("INSERT INTO binders (name, origin) VALUES ('Trade', 'app')").run();
    renameBinder(ctx.db, "Trade", "trade");
    assert.deepEqual(where(ID.sol), [["trade", 5]]);
  });

  test("migration v7 merges binder case variants onto one spelling", () => {
    seed([[ID.sol, 3, { binder: "Trade", source: "scan" }], [ID.sol, 2, { binder: "trade", source: "scan" }]]);
    ctx.db.exec("PRAGMA user_version = 6");
    ctx.db.close();
    ctx.db = openDb(ctx.file);
    assert.deepEqual(where(ID.sol), [["Trade", 5]]);
  });

  test("replace after in-app moves does not count moved copies twice, also with ManaBox master again", async () => {
    const file = csv(line("Main", "Sol Ring", "c21", "263", 1, ID.sol));
    await importManaBoxCsv(ctx.db, file, { mode: "replace" });
    moveCopies(ctx.db, { items: [{ scryfall_id: ID.sol, binder: "Main", quantity: 1 }], to_binder: "Trade", create: true, confirm_master: true });
    setCollectionMaster(ctx.db, "manabox");
    const s = await importManaBoxCsv(ctx.db, file);
    assert.equal(s.mode, "replace");
    assert.equal(s.kept_app_copies, 1);
    assert.equal(solTotal(), 1);
    assert.deepEqual(where(ID.sol), [["Trade", 1]]);
    // ManaBox lost the card: the app copy stays and the decrease is reported.
    const gone = await importManaBoxCsv(ctx.db, csv(line("Main", "Lightning Bolt", "m10", "146", 1, ID.lightning)));
    assert.equal(solTotal(), 1);
    assert.match(gone.decreased[0].message, /fewer copies of Sol Ring/);
  });

  test("a ManaBox deck renamed in the app is matched by its binder on the next sync", async () => {
    const file = csv(line("Elves", "Sol Ring", "c21", "263", 1, ID.sol, "deck"));
    await importManaBoxCsv(ctx.db, file, { mode: "replace" });
    const id = ctx.db.prepare("SELECT id FROM decks WHERE name = 'Elves'").get().id;
    ctx.db.prepare("UPDATE decks SET name = 'My Elves' WHERE id = ?").run(id);
    setCollectionMaster(ctx.db, "app");
    await importManaBoxCsv(ctx.db, file);
    await importManaBoxCsv(ctx.db, file, { mode: "replace", confirm_replace: true });
    assert.deepEqual(ctx.db.prepare("SELECT id, name FROM decks").all().map((r) => [r.id, r.name]), [[id, "My Elves"]]);
    assert.equal(allocation(ctx.db).built.get("o-solring").demand, 1);
  });

  test("deck box: own ManaBox binder counts as boxed; custom and renamed boxes stay protected", async () => {
    await importManaBoxCsv(ctx.db, csv(line("Gruul", "Sol Ring", "c21", "263", 1, ID.sol, "deck")), { mode: "replace" });
    seed([[ID.sol, 1, { source: "scan" }]]);
    const g = ctx.db.prepare("SELECT id FROM decks WHERE name = 'Gruul'").get().id;
    const r = deckToBinder(ctx.db, g);
    assert.deepEqual([r.moved_copies, r.missing_count], [0, 0], "already in its ManaBox binder: nothing moves, no master flip");
    assert.equal(collectionMaster(ctx.db), "manabox");
    assert.deepEqual(where(ID.sol), [["", 1], ["Gruul", 1]]);

    // Built decks X (custom box) and Y share the free Unsorted Sol Ring.
    const X = deck("X", "built", [row("Sol Ring", ID.sol, 1)]);
    const Y = deck("Y", "built", [row("Sol Ring", ID.sol, 1)]);
    assert.equal(deckToBinder(ctx.db, X, { binder: "Red box" }).moved_copies, 1);
    assert.equal(deckToBinder(ctx.db, Y).moved_copies, 0, "the custom box is protected");
    ctx.db.prepare("UPDATE decks SET name = 'X v2' WHERE id = ?").run(X);
    assert.equal(deckToBinder(ctx.db, Y).moved_copies, 0, "still protected after the deck rename");
    const again = deckToBinder(ctx.db, X);
    assert.deepEqual([again.binder, again.moved_copies], ["Red box", 0], "the remembered box is the default target");
    renameBinder(ctx.db, "Red box", "Blue box");
    assert.equal(deckToBinder(ctx.db, Y).moved_copies, 0, "follows a binder rename");
    assert.deepEqual(where(ID.sol), [["Blue box", 1], ["Gruul", 1]]);
  });

  test("basic lands: avail counts every owned copy, cardUsage is never short", () => {
    seed([[ID.forest, 5]]);
    deck("F", "built", [row("Forest", ID.forest, 10)]);
    assert.deepEqual(searchCollection(ctx.db, { q: "avail>=1" }).rows.map((r) => r.name), ["Forest"]);
    const u = cardUsage(ctx.db, { oracle_id: ctx.db.prepare("SELECT oracle_id FROM cards WHERE scryfall_id = ?").get(ID.forest).oracle_id, name: "Forest" });
    assert.deepEqual([u.owned, u.built_demand, u.available, u.basic], [5, 10, 5, true]);
  });
});
