// Build checklist (lib/deckbuild.js): grouping by binder with deckToBinder's take
// order, other built decks' binders, basics and cards to buy; ticks stored per
// line, pruned when the line goes, and "Put into deck box" for the picked cards.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deckToBinder } from "../lib/binders.js";
import { updateDeckCard } from "../lib/decks.js";
import { buildChecklist, clearBuildPicks, pickedKeys, setBuildPick } from "../lib/deckbuild.js";
import { ID, seedCards, tempDb } from "./fixtures.js";

function seed(db) {
  seedCards(db);
  const own = db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, ?, ?, 'app')");
  own.run(ID.sol, "Box A", 1);
  own.run(ID.lightning, "", 1);
  own.run(ID.lightning, "Trade", 1);
  own.run(ID.serra, "Deck box: Other", 1);
  own.run(ID.forest, "", 2);
  const deck = (name, status, box) => Number(db.prepare("INSERT INTO decks (name, status, box_binder) VALUES (?, ?, ?)").run(name, status, box).lastInsertRowid);
  const card = db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, ?)");
  const other = deck("Other", "built", "Deck box: Other");
  card.run(other, "main", "Serra Angel", ID.serra, 1);
  const id = deck("Build me", "idea", null);
  card.run(id, "main", "Sol Ring", ID.sol, 1);
  card.run(id, "main", "Lightning Bolt", ID.lightning, 2);
  card.run(id, "main", "Serra Angel", ID.serra, 1);
  card.run(id, "main", "Counterspell", ID.counterspell, 1);
  card.run(id, "main", "Forest", ID.forest, 5);
  card.run(id, "maybe", "Atraxa, Praetors' Voice", ID.atraxa, 1);
  return id;
}

const shape = (list) => list.groups.map((g) => [g.kind, g.title, g.lines.map((l) => `${l.quantity} ${l.name}`).join(", ")]);

describe("build checklist", () => {
  let ctx, id;
  beforeEach(() => { ctx = tempDb(); id = seed(ctx.db); });
  afterEach(() => ctx.cleanup());

  test("groups the needed copies by where they lie; maybe board left out", () => {
    const list = buildChecklist(ctx.db, id);
    assert.deepEqual(shape(list), [
      ["binder", "Unsorted", "2 Forest, 1 Lightning Bolt"],
      ["binder", "Box A", "1 Sol Ring"],
      ["binder", "Trade", "1 Lightning Bolt"],
      ["other", "In other decks", "1 Serra Angel"],
      ["basics", "Basic lands", "3 Forest"],
      ["buy", "To buy", "1 Counterspell"],
    ]);
    const serra = list.groups[3].lines[0];
    assert.deepEqual([serra.binder, serra.decks], ["Deck box: Other", ["Other"]]);
    assert.equal(list.groups[5].lines[0].price_eur, 1);
    assert.deepEqual([list.total, list.picked, list.complete, list.box_binder], [10, 0, false, "Deck box: Build me"]);
  });

  test("ticks persist per line, clamp to the line, untick deletes; bad lines refused", () => {
    let list = setBuildPick(ctx.db, id, { key: "o-forest", source: "basics", quantity: 9 });
    assert.equal(list.picked, 3);
    list = setBuildPick(ctx.db, id, { key: "o-bolt", source: "b:trade", quantity: 1 });
    assert.deepEqual([list.picked, list.movable_picked], [4, 1]);
    assert.equal(buildChecklist(ctx.db, id).picked, 4, "stored on the server");
    list = setBuildPick(ctx.db, id, { key: "o-forest", source: "basics", quantity: 0 });
    assert.equal(list.picked, 1);
    assert.throws(() => setBuildPick(ctx.db, id, { key: "o-nope", source: "buy", quantity: 1 }), (e) => e.status === 404);
    assert.throws(() => setBuildPick(ctx.db, id, { key: "o-bolt", source: "b:trade", quantity: -1 }), (e) => e.status === 400);
    assert.equal(clearBuildPicks(ctx.db, id).picked, 0);
  });

  test("a card leaving the deck drops its tick; the rest stay", () => {
    setBuildPick(ctx.db, id, { key: "o-counter", source: "buy", quantity: 1 });
    setBuildPick(ctx.db, id, { key: "o-solring", source: "b:box a", quantity: 1 });
    updateDeckCard(ctx.db, id, { name: "Counterspell", board: "main", quantity: 0 });
    const list = buildChecklist(ctx.db, id);
    assert.deepEqual([list.total, list.picked], [9, 1]);
    setBuildPick(ctx.db, id, { key: "o-solring", source: "b:box a", quantity: 1 });
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM deck_build_picks WHERE deck_id = ?").get(id).n, 1, "stale pick pruned");
  });

  test("Put into deck box moves only the picked cards; they then count as boxed", () => {
    setBuildPick(ctx.db, id, { key: "o-solring", source: "b:box a", quantity: 1 });
    assert.deepEqual(pickedKeys(ctx.db, id), ["o-solring"]);
    const r = deckToBinder(ctx.db, id, { keys: pickedKeys(ctx.db, id) });
    assert.deepEqual([r.binder, r.moved_copies, r.moved.map((m) => m.name)], ["Deck box: Build me", 1, ["Sol Ring"]]);
    const list = buildChecklist(ctx.db, id);
    const box = list.groups.find((g) => g.kind === "box");
    assert.deepEqual(box.lines.map((l) => [l.name, l.picked]), [["Sol Ring", 1]]);
    assert.equal(list.groups.at(-1).kind, "box", "boxed copies come last");
    assert.equal(list.picked, 1);
    // Lightning Bolt was not picked: still in Unsorted / Trade.
    assert.equal(ctx.db.prepare("SELECT SUM(quantity) AS n FROM collection WHERE scryfall_id = ? AND binder <> 'Deck box: Build me'").get(ID.lightning).n, 2);
  });

  test("a built deck takes contested copies like deckToBinder; 404 for a missing deck", () => {
    ctx.db.prepare("UPDATE decks SET status = 'built' WHERE id = ?").run(id);
    const list = buildChecklist(ctx.db, id);
    // Serra Angel stays in the other built deck's box (never taken from there).
    assert.deepEqual(list.groups.find((g) => g.kind === "other").lines.map((l) => l.name), ["Serra Angel"]);
    assert.throws(() => buildChecklist(ctx.db, 9999), (e) => e.status === 404);
  });
});
