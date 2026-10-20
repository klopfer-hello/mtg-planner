// Card list → collection (lib/listimport.js): a bought precon with a deck, merging into existing rows,
// undo through the edit log, errors. Scryfall is stubbed.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { addCardList, resolveCardList } from "../lib/listimport.js";
import { listEdits, undoEdit } from "../lib/edits.js";
import { parseDecklist } from "../lib/deckrules.js";
import { ID, seedCards, stubScryfall, tempDb } from "./fixtures.js";

const PRECON = [
  "Commander",
  "1 Atraxa, Praetors' Voice",
  "",
  "Deck",
  "1 Sol Ring",
  "2 Lightning Bolt *F*",
  "3 Forest",
  "",
  "Maybeboard",
  "1 Serra Angel",
].join("\n");

describe("card list import", () => {
  let ctx, stub;
  beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); stub = stubScryfall(); });
  afterEach(() => { stub.restore(); ctx.cleanup(); });
  const rowsOf = () => ctx.db.prepare(
    "SELECT c.name, col.finish, col.language, col.condition, col.binder, col.quantity, col.source FROM collection col JOIN cards c USING (scryfall_id) ORDER BY c.name, col.finish",
  ).all().map((r) => ({ ...r }));

  test("parseDecklist keeps *F* / *E* as the line's finish", () => {
    const { items } = parseDecklist("1 Sol Ring *F*\n1 Bolt *E*\n1 Forest");
    assert.deepEqual(items.map((i) => i.finish ?? null), ["foil", "etched", null]);
  });

  test("a precon: owned boards into one binder, foil marker kept, maybe skipped, built deck with its box, one log entry", async () => {
    const resolved = await resolveCardList(ctx.db, PRECON);
    const out = addCardList(ctx.db, resolved, { binder: "Deck box: Angels", language: "de", condition: "excellent", deck: { name: "Angels", format: "Commander" } });
    assert.deepEqual([out.binder, out.created, out.added_copies, out.cards], ["Deck box: Angels", true, 7, 4]);
    assert.deepEqual(rowsOf(), [
      { name: "Atraxa, Praetors' Voice", finish: "normal", language: "de", condition: "excellent", binder: "Deck box: Angels", quantity: 1, source: "app" },
      { name: "Forest", finish: "normal", language: "de", condition: "excellent", binder: "Deck box: Angels", quantity: 3, source: "app" },
      { name: "Lightning Bolt", finish: "foil", language: "de", condition: "excellent", binder: "Deck box: Angels", quantity: 2, source: "app" },
      { name: "Sol Ring", finish: "normal", language: "de", condition: "excellent", binder: "Deck box: Angels", quantity: 1, source: "app" },
    ]);
    const deck = ctx.db.prepare("SELECT * FROM decks WHERE id = ?").get(out.deck_id);
    assert.deepEqual([deck.status, deck.format, deck.box_binder], ["built", "commander", "Deck box: Angels"]);
    const boards = ctx.db.prepare("SELECT board, SUM(quantity) q FROM deck_cards WHERE deck_id = ? GROUP BY board ORDER BY board").all(out.deck_id).map((r) => [r.board, r.q]);
    assert.deepEqual(boards, [["commander", 1], ["main", 6], ["maybe", 1]], "the deck keeps every board");
    const [edit] = listEdits(ctx.db, { limit: 1 });
    assert.deepEqual([edit.kind, edit.copies, edit.undoable], ["add", 7, true]);
    assert.match(edit.summary, /^Added 7 copies to Deck box: Angels: /);
    undoEdit(ctx.db, edit.id);
    assert.deepEqual(rowsOf(), [], "undo takes the added copies away again");
  });

  test("adds to an existing row of the same key; undo restores its quantity; name-only lines don't reuse owned printings", async () => {
    ctx.db.prepare("INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, 'normal', 'en', 'near_mint', 'Box', 2, 'app')").run(ID.sol);
    const calls = stub.calls.length;
    const out = addCardList(ctx.db, await resolveCardList(ctx.db, "2 Sol Ring"), { binder: "Box", create: false });
    assert.ok(stub.calls.length > calls, "looked up on Scryfall, not the owned copy");
    assert.equal(out.created, false);
    assert.deepEqual(rowsOf().map((r) => [r.name, r.binder, r.quantity]), [["Sol Ring", "Box", 4]], "merged into the existing row");
    undoEdit(ctx.db, out.edit_id);
    assert.deepEqual(rowsOf().map((r) => [r.name, r.quantity]), [["Sol Ring", 2]]);
  });

  test("errors: empty list, nothing found, bad condition/language, unknown binder without create", async () => {
    await assert.rejects(async () => addCardList(ctx.db, await resolveCardList(ctx.db, "")), (e) => e.status === 400);
    await assert.rejects(async () => addCardList(ctx.db, await resolveCardList(ctx.db, "1 No Such Card Anywhere")), (e) => e.status === 400 && /No card of the list/.test(e.message));
    const ok = await resolveCardList(ctx.db, "1 Sol Ring");
    assert.throws(() => addCardList(ctx.db, ok, { condition: "shiny" }), (e) => e.status === 400);
    assert.throws(() => addCardList(ctx.db, ok, { language: "German" }), (e) => e.status === 400);
    assert.throws(() => addCardList(ctx.db, ok, { binder: "Nope", create: false }), (e) => e.status === 404);
    assert.throws(() => addCardList(ctx.db, ok, { deck: { name: " " } }), (e) => e.status === 400);
    assert.deepEqual(rowsOf(), []);
    const partly = await resolveCardList(ctx.db, "1 Sol Ring\n1 No Such Card Anywhere\nthis is not a line");
    const out = addCardList(ctx.db, partly, {});
    assert.deepEqual([out.added_copies, out.unresolved, out.parse_errors, out.binder], [1, ["No Such Card Anywhere"], ["this is not a line"], ""]);
  });
});
