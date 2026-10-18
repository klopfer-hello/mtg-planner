// Locked binders (lib/deckboxes.js + lib/decks.js allocation): copies in a locked binder
// (the user's lock, else auto = deck boxes) are free only for the deck that owns it; every
// other deck sees them in use ("in locked binder X"), never free and never to buy. Covers the
// migration (v16), the owner rules, the built deck's own box (no double count), the lock
// override, "Put into deck box", the build checklist, the avail:/used: search keys, the box
// link and the name suggestion.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cardUsage, deckDetail, deckToText, listDecks, saveDeckRows } from "../lib/decks.js";
import { createBinder, deckToBinder, listBinders, renameBinder, setBinderProps } from "../lib/binders.js";
import { SCHEMA_VERSION, migrate, openDb } from "../lib/db.js";
import { buildChecklist } from "../lib/deckbuild.js";
import { searchCollection } from "../lib/query.js";
import { boxNameSimilarity, boxNameWords, boxSuggestion, deckBoxes, effectiveLock, lockedBinders } from "../lib/deckboxes.js";
import { ID, seedCards, tempDb } from "./fixtures.js";

let ctx;
beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); });
afterEach(() => ctx.cleanup());

/** rows of [scryfall_id, quantity, binder] */
function seed(rows) {
  const stmt = ctx.db.prepare(
    "INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, 'normal', 'en', 'near_mint', ?, ?, 'app')",
  );
  for (const [id, qty, binder = ""] of rows) stmt.run(id, binder, qty);
}
const row = (name, id, quantity, board = "main") => ({ name, scryfall_id: id, quantity, board });
const deck = (name, status, rows) => saveDeckRows(ctx.db, { name, status, rows });
const pick = (detail, name) => detail.cards.find((c) => c.name === name);
const PRECON = "Commander Deck: Rin and Seri";

describe("migration v16: binders.locked", () => {
  const cols = (db) => db.prepare("PRAGMA table_info(binders)").all().map((c) => c.name);

  test("fresh database has the column; nothing is locked by hand", () => {
    assert.equal(SCHEMA_VERSION, 17);
    assert.ok(cols(ctx.db).includes("locked"));
    createBinder(ctx.db, "Fresh");
    assert.equal(ctx.db.prepare("SELECT locked FROM binders WHERE name = 'Fresh'").get().locked, null);
  });

  test("v15 -> v16: deck boxes start locked (auto), other binders unlocked; a user choice survives a re-run", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Deck box: Elves"], [ID.serra, 1, "Foundation"], [ID.counterspell, 1, "Trade"]]);
    setBinderProps(ctx.db, "Trade", { type: "deck_box" });
    ctx.db.exec("ALTER TABLE binders DROP COLUMN locked; PRAGMA user_version = 15");
    ctx.db.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(ctx.file);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      assert.ok(cols(db).includes("locked"));
      const locks = listBinders(db).binders.map((b) => [b.name, b.locked, b.locked_set]);
      assert.deepEqual(locks, i === 0
        ? [[PRECON, true, false], ["Deck box: Elves", true, false], ["Foundation", false, false], ["Trade", true, false]]
        : [[PRECON, false, true], ["Deck box: Elves", true, false], ["Foundation", true, true], ["Trade", true, false]]);
      if (i === 0) {
        setBinderProps(db, "Foundation", { locked: true });
        setBinderProps(db, PRECON, { locked: false });
      }
      db.exec("PRAGMA user_version = 15"); // re-run v16 on a migrated DB
      migrate(db);
      db.close();
    }
    ctx.db = openDb(ctx.file);
  });
});

describe("migration v17 + favourites", () => {
  test("columns exist and start at 0; favourite set/unset, Unsorted refused, rename and merge keep it", () => {
    for (const t of ["decks", "binders"]) {
      assert.ok(ctx.db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === "favorite"), t);
    }
    seed([[ID.sol, 1, "Trade"], [ID.lightning, 1, "Bulk"], [ID.serra, 1, "Other"]]);
    const fav = () => Object.fromEntries(listBinders(ctx.db).binders.map((b) => [b.name, b.favorite]));
    assert.deepEqual(fav(), { Bulk: false, Other: false, Trade: false });
    setBinderProps(ctx.db, "Trade", { favorite: true });
    assert.equal(fav().Trade, true);
    assert.throws(() => setBinderProps(ctx.db, "", { favorite: true }), /Unsorted/);
    assert.throws(() => setBinderProps(ctx.db, "Trade", { favorite: 1 }), /true or false/);
    renameBinder(ctx.db, "Trade", "Trades", { confirm_master: true });
    assert.equal(fav().Trades, true, "follows a rename");
    renameBinder(ctx.db, "Trades", "Bulk", { confirm_master: true });
    assert.equal(fav().Bulk, true, "a merge keeps either favourite");
    setBinderProps(ctx.db, "Bulk", { favorite: false });
    assert.equal(fav().Bulk, false);
  });
});

describe("locked binders (deck boxes are locked by default)", () => {
  test("an unlinked precon box: its copies are in use for an idea deck, not free and not to buy", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, PRECON], [ID.lightning, 1]]);
    const idea = deck("Plan", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 2), row("Counterspell", ID.counterspell, 1)]);
    const d = deckDetail(ctx.db, idea, { power: false });
    const sol = pick(d, "Sol Ring");
    assert.deepEqual([sol.owned, sol.available_for_this, sol.in_use, sol.in_use_box, sol.to_buy, sol.conflict], [1, 0, 1, 1, 0, false]);
    assert.deepEqual(sol.in_boxes, [{ binder: PRECON, deck_id: null, deck_name: null, quantity: 1 }]);
    const bolt = pick(d, "Lightning Bolt");
    assert.deepEqual([bolt.available_for_this, bolt.in_use, bolt.to_buy], [1, 1, 0], "the Unsorted copy is free");
    assert.deepEqual([d.in_use_count, d.in_use_box_count, d.to_buy_count, d.conflict_count], [2, 2, 1, 0]);
    assert.deepEqual(d.shopping.in_use.find((x) => x.name === "Sol Ring").boxes, [{ binder: PRECON, deck_id: null, deck_name: null }]);
    assert.deepEqual([sol.in_locked, sol.in_use_locked, d.in_use_locked_count], [sol.in_boxes, 1, 2], "lock aliases");
    assert.match(deckToText(d), /IN USE 1 in locked binder Commander Deck: Rin and Seri \(can be moved\)/);
    assert.match(deckToText(d), /In locked binders: 2 cards/);
    const listed = listDecks(ctx.db).find((x) => x.id === idea);
    assert.deepEqual([listed.in_use_box_count, listed.in_use_locked_count], [2, 2]);
    const u = cardUsage(ctx.db, { oracle_id: "o-solring", name: "Sol Ring" });
    assert.deepEqual([u.owned, u.built_demand, u.boxed, u.available], [1, 0, 1, 0]);
  });

  test("a linked box is free for its own deck only", () => {
    seed([[ID.sol, 1, "Odds Box"]]);
    const owner = deck("Odds", "idea", [row("Sol Ring", ID.sol, 1)]);
    const other = deck("Other", "idea", [row("Sol Ring", ID.sol, 1)]);
    setBinderProps(ctx.db, "Odds Box", { deck_id: owner });
    assert.equal(lockedBinders(ctx.db).get("odds box").owners[0].id, owner, "the link makes it a deck box: locked (auto)");
    assert.equal(deckBoxes, lockedBinders, "old name kept");
    const mine = deckDetail(ctx.db, owner, { power: false });
    assert.deepEqual([pick(mine, "Sol Ring").available_for_this, pick(mine, "Sol Ring").in_use], [1, 0]);
    assert.deepEqual(mine.box, { binder: "Odds Box", via: "link" });
    assert.match(deckToText(mine), /Deck box: Odds Box/);
    const theirs = pick(deckDetail(ctx.db, other, { power: false }), "Sol Ring");
    assert.deepEqual([theirs.available_for_this, theirs.in_use], [0, 1]);
    assert.deepEqual(theirs.in_boxes, [{ binder: "Odds Box", deck_id: owner, deck_name: "Odds", quantity: 1 }]);
  });

  test("a built deck's own box and its claim reserve the same copies once", () => {
    // Built B: 2 Bolt, its box holds 1 Bolt; 2 more in Unsorted. Owned 3 → free for others 1 (not 0).
    seed([[ID.lightning, 1, "Deck box: B"], [ID.lightning, 2], [ID.sol, 3, "Deck box: B"]]);
    const b = deck("B", "built", [row("Lightning Bolt", ID.lightning, 2), row("Sol Ring", ID.sol, 1)]);
    const c = deck("C", "idea", [row("Lightning Bolt", ID.lightning, 3), row("Sol Ring", ID.sol, 3)]);
    const d = deckDetail(ctx.db, c, { power: false });
    const bolt = pick(d, "Lightning Bolt");
    assert.deepEqual([bolt.available_for_this, bolt.in_use, bolt.in_use_box, bolt.in_boxes.length], [1, 2, 0, 0], "claim 2 ≥ box 1");
    // Box holds 3 Sol Rings, B claims 1: all 3 are reserved (1 by the claim, 2 by the box).
    const sol = pick(d, "Sol Ring");
    assert.deepEqual([sol.available_for_this, sol.in_use, sol.in_use_box], [0, 3, 2]);
    assert.deepEqual(sol.in_boxes, [{ binder: "Deck box: B", deck_id: b, deck_name: "B", quantity: 2 }]);
    // B itself: its box is free for it.
    const own = deckDetail(ctx.db, b, { power: false });
    assert.deepEqual([pick(own, "Lightning Bolt").available_for_this, pick(own, "Sol Ring").available_for_this], [3, 3]);
    assert.equal(own.conflict_count, 0);
    // Global view: Sol 3 owned − max(claim 1, box 3) = 0; Bolt 3 − max(2, 1) = 1.
    assert.equal(cardUsage(ctx.db, { oracle_id: "o-solring", name: "Sol Ring" }).available, 0);
    assert.equal(cardUsage(ctx.db, { oracle_id: "o-bolt", name: "Lightning Bolt" }).available, 1);
  });

  test("locks never make a conflict; built decks still do", () => {
    seed([[ID.sol, 1, PRECON]]);
    const a = deck("A", "built", [row("Sol Ring", ID.sol, 1)]);
    const d = deckDetail(ctx.db, a, { power: false });
    assert.deepEqual([pick(d, "Sol Ring").in_use, pick(d, "Sol Ring").conflict, d.conflict_count], [1, false, 0]);
  });

  test("auto lock follows the effective type: a precon retyped as binder is free, a binder typed deck_box is locked", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Stuff"]]);
    const idea = deck("Plan", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 1)]);
    let d = deckDetail(ctx.db, idea, { power: false });
    assert.deepEqual([pick(d, "Sol Ring").in_use, pick(d, "Lightning Bolt").in_use], [1, 0]);
    setBinderProps(ctx.db, PRECON, { type: "binder" });
    setBinderProps(ctx.db, "Stuff", { type: "deck_box" });
    d = deckDetail(ctx.db, idea, { power: false });
    assert.deepEqual([pick(d, "Sol Ring").in_use, pick(d, "Lightning Bolt").in_use], [0, 1]);
    const b = listBinders(ctx.db).binders;
    assert.deepEqual(b.map((x) => [x.name, x.locked, x.reserved, x.locked_set]), [[PRECON, false, false, false], ["Stuff", true, true, false]]);
  });

  test("the user's lock wins over the type, both ways; null goes back to auto", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Foundation"]]);
    const idea = deck("Plan", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 1)]);
    const uses = () => { const d = deckDetail(ctx.db, idea, { power: false }); return [pick(d, "Sol Ring").in_use, pick(d, "Lightning Bolt").in_use]; };
    assert.deepEqual(uses(), [1, 0]);
    let r = setBinderProps(ctx.db, "Foundation", { locked: true });
    const f = r.binders.find((x) => x.name === "Foundation");
    assert.deepEqual([f.type, f.locked, f.locked_set, f.locked_auto, f.box_deck], ["binder", true, true, false, null], "a plain binder, locked, no owner");
    setBinderProps(ctx.db, PRECON, { locked: false });
    assert.deepEqual(uses(), [0, 1]);
    const bolt = pick(deckDetail(ctx.db, idea, { power: false }), "Lightning Bolt");
    assert.deepEqual([bolt.available_for_this, bolt.to_buy, bolt.in_locked], [0, 0, [{ binder: "Foundation", deck_id: null, deck_name: null, quantity: 1 }]]);
    assert.equal(listBinders(ctx.db).binders.find((x) => x.name === PRECON).type, "deck_box", "the type stays");
    r = setBinderProps(ctx.db, "Foundation", { locked: null });
    setBinderProps(ctx.db, PRECON, { locked: null });
    assert.deepEqual(uses(), [1, 0], "back to automatic");
    assert.equal(r.binders.find((x) => x.name === "Foundation").locked_set, false);
    assert.throws(() => setBinderProps(ctx.db, "Foundation", { locked: "yes" }), (e) => e.status === 400);
    assert.throws(() => setBinderProps(ctx.db, "", { locked: true }), (e) => e.status === 400, "Unsorted can't be locked");
    assert.equal(effectiveLock(null, "deck_box"), true);
    assert.equal(effectiveLock(0, "deck_box"), false);
    assert.equal(effectiveLock(1, "trade"), true);
  });

  test("a locked plain binder is free for its owner deck only (name match or link)", () => {
    seed([[ID.sol, 1, "Elves"], [ID.lightning, 1, "Shelf"]]);
    const elves = deck("Elves", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 1)]);
    const other = deck("Other", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 1)]);
    setBinderProps(ctx.db, "Elves", { type: "binder", locked: true });
    setBinderProps(ctx.db, "Shelf", { locked: true, deck_id: elves });
    const mine = deckDetail(ctx.db, elves, { power: false });
    assert.deepEqual([pick(mine, "Sol Ring").in_use, pick(mine, "Lightning Bolt").in_use], [0, 0]);
    const theirs = deckDetail(ctx.db, other, { power: false });
    assert.deepEqual(theirs.cards.map((c) => [c.name, c.in_use, c.in_use_locked, c.to_buy]), [["Lightning Bolt", 1, 1, 0], ["Sol Ring", 1, 1, 0]]);
    assert.deepEqual(pick(theirs, "Sol Ring").in_locked, [{ binder: "Elves", deck_id: elves, deck_name: "Elves", quantity: 1 }]);
    assert.equal(theirs.conflict_count, 0);
  });

  test("the lock follows a rename; a merge keeps the target's own choice", () => {
    seed([[ID.sol, 1, "A"], [ID.lightning, 1, "B"]]);
    setBinderProps(ctx.db, "A", { locked: true });
    renameBinder(ctx.db, "A", "A2", { confirm_master: true });
    assert.equal(lockedBinders(ctx.db).has("a2"), true);
    setBinderProps(ctx.db, "B", { locked: false });
    renameBinder(ctx.db, "A2", "B", { confirm_master: true });
    assert.equal(lockedBinders(ctx.db).has("b"), false);
  });

  test("basics stay free in a box", () => {
    seed([[ID.forest, 5, PRECON]]);
    const idea = deck("Plan", "idea", [row("Forest", ID.forest, 5)]);
    const f = pick(deckDetail(ctx.db, idea, { power: false }), "Forest");
    assert.deepEqual([f.in_use, f.to_buy, f.in_boxes], [0, 0, []]);
  });
});

describe("Put into deck box and the build list never take from locked binders", () => {
  test("deckToBinder skips every other locked binder (unlinked, idea-owned, built-owned)", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Deck box: Idea"], [ID.serra, 1, "Deck box: Built"], [ID.counterspell, 1]]);
    deck("Idea", "idea", [row("Lightning Bolt", ID.lightning, 1)]);
    deck("Built", "built", [row("Atraxa, Praetors' Voice", ID.atraxa, 1)]);
    for (const status of ["idea", "built"]) {
      const id = deck(`New ${status}`, status, [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 1),
        row("Serra Angel", ID.serra, 1), row("Counterspell", ID.counterspell, 1)]);
      const r = deckToBinder(ctx.db, id, { confirm_master: true });
      assert.deepEqual(r.moved.map((m) => [m.name, m.from]), [["Counterspell", [{ binder: "", quantity: 1 }]]], status);
      assert.deepEqual(r.missing.map((m) => m.name).sort(), ["Lightning Bolt", "Serra Angel", "Sol Ring"]);
      // Put the Counterspell back for the next round.
      ctx.db.prepare("UPDATE collection SET binder = '' WHERE binder = ?").run(`Deck box: New ${status}`);
    }
    assert.equal(ctx.db.prepare("SELECT SUM(quantity) AS q FROM collection WHERE binder = ?").get(PRECON).q, 1, "precon untouched");
  });

  test("deckToBinder: a locked plain binder is skipped, unlocked it is a source again", () => {
    seed([[ID.counterspell, 1, "Foundation"]]);
    const id = deck("Plan", "built", [row("Counterspell", ID.counterspell, 1)]);
    setBinderProps(ctx.db, "Foundation", { locked: true });
    let r = deckToBinder(ctx.db, id, { confirm_master: true });
    assert.deepEqual([r.moved_copies, r.missing.map((m) => m.name)], [0, ["Counterspell"]]);
    setBinderProps(ctx.db, "Foundation", { locked: false });
    r = deckToBinder(ctx.db, id, { confirm_master: true });
    assert.deepEqual(r.moved.map((m) => [m.name, m.from]), [["Counterspell", [{ binder: "Foundation", quantity: 1 }]]]);
  });

  test("build list: copies in locked binders go to 'In other decks or locked binders', never to a binder group", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Trade"], [ID.lightning, 1, PRECON]]);
    const id = deck("Plan", "idea", [row("Sol Ring", ID.sol, 1), row("Lightning Bolt", ID.lightning, 2)]);
    const list = buildChecklist(ctx.db, id);
    assert.deepEqual(list.groups.map((g) => [g.kind, g.title, g.lines.map((l) => `${l.quantity} ${l.name}`).join(", ")]), [
      ["binder", "Trade", "1 Lightning Bolt"],
      ["other", "In other decks or locked binders", "1 Lightning Bolt, 1 Sol Ring"],
    ]);
    const sol = list.groups[1].lines.find((l) => l.name === "Sol Ring");
    assert.deepEqual([sol.binder, sol.box, sol.locked, sol.decks], [PRECON, true, true, []]);
    // Locking Trade moves its Bolt out of the binder groups; unlocking the precon frees its copies.
    setBinderProps(ctx.db, "Trade", { locked: true });
    setBinderProps(ctx.db, PRECON, { locked: false });
    assert.deepEqual(buildChecklist(ctx.db, id).groups.map((g) => [g.kind, g.title, g.lines.map((l) => `${l.quantity} ${l.name}`).join(", ")]), [
      ["binder", PRECON, "1 Lightning Bolt, 1 Sol Ring"],
      ["other", "In other decks or locked binders", "1 Lightning Bolt"],
    ]);
  });
});

describe("search: avail / used", () => {
  test("avail leaves out copies in locked binders; used counts them", () => {
    seed([[ID.sol, 2, PRECON], [ID.sol, 1], [ID.lightning, 1, "Trade"]]);
    const names = (q) => searchCollection(ctx.db, { q }).rows.map((r) => r.name);
    const sol = searchCollection(ctx.db, { q: "sol" }).rows[0];
    assert.deepEqual([sol.qty, sol.used, sol.boxed, sol.avail], [3, 2, 2, 1]);
    assert.deepEqual(names("avail>=2"), []);
    assert.deepEqual(names("avail>=1"), ["Lightning Bolt", "Sol Ring"]);
    assert.deepEqual(names("is:used"), ["Sol Ring"]);
    assert.deepEqual(names("used:no"), ["Lightning Bolt"]);
    // Owned by an idea deck: still reserved for everyone else (the search has no viewer).
    const owner = deck("Rin", "idea", [row("Sol Ring", ID.sol, 2)]);
    setBinderProps(ctx.db, PRECON, { deck_id: owner });
    assert.equal(searchCollection(ctx.db, { q: "sol" }).rows[0].avail, 1);
    // A built owner claiming the copies: claim and box count once.
    ctx.db.prepare("UPDATE decks SET status = 'built' WHERE id = ?").run(owner);
    assert.deepEqual(["used", "boxed", "avail"].map((k) => searchCollection(ctx.db, { q: "sol" }).rows[0][k]), [2, 0, 1]);
    // A locked plain binder counts; unlocked again it doesn't.
    setBinderProps(ctx.db, "Trade", { locked: true });
    assert.deepEqual(names("avail>=1"), ["Sol Ring"]);
    assert.deepEqual(names("is:used"), ["Lightning Bolt", "Sol Ring"]);
    setBinderProps(ctx.db, "Trade", { locked: false });
    assert.deepEqual(names("used:no"), ["Lightning Bolt"]);
  });
});

describe("linking a box to a deck", () => {
  test("one box per deck, one deck per box; null unlinks; bad ids refused", () => {
    seed([[ID.sol, 1, PRECON], [ID.lightning, 1, "Box 2"]]);
    const a = deck("A", "idea", [row("Sol Ring", ID.sol, 1)]);
    const b = deck("B", "idea", [row("Sol Ring", ID.sol, 1)]);
    let r = setBinderProps(ctx.db, PRECON, { deck_id: a });
    assert.deepEqual(r.binders.find((x) => x.name === PRECON).box_deck, { id: a, name: "A", status: "idea", via: "link" });
    r = setBinderProps(ctx.db, PRECON, { deck_id: b });
    assert.deepEqual(ctx.db.prepare("SELECT id, box_binder FROM decks ORDER BY id").all().map((x) => [x.id, x.box_binder]), [[a, null], [b, PRECON]]);
    setBinderProps(ctx.db, "Box 2", { deck_id: b });
    assert.deepEqual(ctx.db.prepare("SELECT id, box_binder FROM decks ORDER BY id").all().map((x) => [x.id, x.box_binder]), [[a, null], [b, "Box 2"]],
      "a deck has one box: the new link replaces the old");
    r = setBinderProps(ctx.db, "Box 2", { deck_id: null });
    assert.equal(r.binders.find((x) => x.name === "Box 2").box_deck, null);
    assert.equal(ctx.db.prepare("SELECT box_binder FROM decks WHERE id = ?").get(b).box_binder, null);
    assert.throws(() => setBinderProps(ctx.db, PRECON, { deck_id: 999 }), (e) => e.status === 404);
    assert.throws(() => setBinderProps(ctx.db, PRECON, { deck_id: "1" }), (e) => e.status === 400);
  });

  test("name suggestion for an unowned box: close names only, never a silent link", () => {
    assert.deepEqual(boxNameWords("Secret Lair Commander: Odds & Ends"), ["secret", "lair", "odds", "and", "ends"]);
    assert.equal(boxNameSimilarity("Secret Lair Commander: Odds and Ends", "Secret Lair Commander Deck: Odds and Ends"), 1);
    assert.equal(boxNameSimilarity("Foundation Commander: Blue Mono", "Mono Blue Tempo"), 0.5);
    assert.equal(boxNameSimilarity("Commander Deck: Rin and Seri", "Seri"), 0, "one shared word is not enough");
    seed([[ID.sol, 1, "Secret Lair Commander: Odds and Ends"], [ID.lightning, 1, "Foundation Commander: Blue Mono"]]);
    const odds = deck("Secret Lair Commander Deck: Odds and Ends", "built", [row("Sol Ring", ID.sol, 1)]);
    deck("Mono Blue Tempo", "idea", [row("Lightning Bolt", ID.lightning, 1)]);
    const list = () => listBinders(ctx.db).binders;
    const sl = list().find((x) => x.name.startsWith("Secret"));
    assert.deepEqual([sl.reserved, sl.box_deck, sl.deck_suggest?.id], [true, null, odds]);
    assert.equal(list().find((x) => x.name.startsWith("Foundation")).deck_suggest, null);
    assert.equal(ctx.db.prepare("SELECT box_binder FROM decks WHERE id = ?").get(odds).box_binder, null, "not linked on its own");
    // Unlinked, the built deck sees its own precon box as in use (that's what the link fixes).
    assert.equal(pick(deckDetail(ctx.db, odds, { power: false }), "Sol Ring").in_use, 1);
    setBinderProps(ctx.db, sl.name, { deck_id: odds });
    assert.equal(list().find((x) => x.name.startsWith("Secret")).deck_suggest, null);
    assert.equal(pick(deckDetail(ctx.db, odds, { power: false }), "Sol Ring").in_use, 0);
    assert.equal(boxSuggestion("Secret Lair Commander: Odds and Ends", [{ id: odds, name: "Secret Lair Commander Deck: Odds and Ends" }], new Set([odds])), null,
      "a deck that has a box gets no second one");
  });
});
