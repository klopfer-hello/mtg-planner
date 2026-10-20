// lib/edits.js: editing / deleting owned copies (splits, merges, ManaBox rows and
// the collection master), the edit log with exact undo and conflict detection,
// deck allocation after edits, what ManaBox imports do afterwards, old
// relanguage log entries, and migration v8 from a v7 database with data.
// Scryfall is stubbed; no network.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openDb, setAppMeta, transaction, upsertCards } from "../lib/db.js";
import { tracker, writeLog } from "../lib/editlog.js";
import { collectionMaster, deleteBinder, listBinders, moveCopies, setCollectionMaster } from "../lib/binders.js";
import { deckDetail, saveDeckRows } from "../lib/decks.js";
import { importManaBoxCsv } from "../lib/manabox.js";
import { deleteCopies, editCopies, listEdits, undoEdit } from "../lib/edits.js";
import { normalizeCard } from "../lib/scryfall.js";
import { commitScans } from "../lib/scancommit.js";
import { ID, SCRYFALL_CARDS, seedCards, stubScryfall, tempDb } from "./fixtures.js";

let ctx;
beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); });
afterEach(() => ctx.cleanup());

/** rows of [scryfall_id, quantity, {binder, source, finish, language, condition, price}] -> ids */
function seed(rows) {
  const stmt = ctx.db.prepare(
    `INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source, purchase_price, purchase_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return rows.map(([id, qty, o = {}]) => Number(stmt.run(id, o.finish ?? "normal", o.language ?? "en", o.condition ?? "near_mint", o.binder ?? "",
    qty, o.source ?? "scan", o.price ?? null, o.price != null ? "EUR" : null).lastInsertRowid));
}
const all = () => ctx.db.prepare("SELECT * FROM collection ORDER BY id").all().map((r) => ({ ...r }));
const keys = () => ctx.db.prepare(
  "SELECT scryfall_id, finish, language, condition, binder, source, quantity FROM collection ORDER BY scryfall_id, language, finish, condition, binder, source",
).all().map((r) => `${r.scryfall_id.slice(-2)}/${r.finish}/${r.language}/${r.condition}/${r.binder}/${r.source}=${r.quantity}`);
const item = (id, quantity, o = {}) => ({ scryfall_id: id, finish: "normal", language: "en", condition: "near_mint", binder: "", ...o, quantity });
const err = (status, code) => (e) => e.status === status && (code == null || e.extra?.code === code);

// An Italian Lightning Bolt (same oracle card) that is not in the cards table yet.
const BOLT_IT = { ...SCRYFALL_CARDS.find((c) => c.id === ID.lightning), id: "00000000-0000-0000-0000-0000000000a1", lang: "it", prices: {} };
const noFetch = async () => { throw new Error("no network in this test"); };
const fetchPool = (pool) => async (ids) => ({ cards: pool.filter((c) => ids.includes(c.id)), notFound: [] });

describe("editCopies", () => {
  test("partial quantity splits a row; undo restores the exact row", async () => {
    const [id] = seed([[ID.lightning, 3, { binder: "Box", price: 1.5 }]]);
    const r = await editCopies(ctx.db, { items: [item(ID.lightning, 1, { binder: "Box" })], set: { language: "IT" } }, { fetchCards: noFetch });
    assert.equal(r.edited_copies, 1);
    assert.equal(r.converted_copies, 0);
    assert.deepEqual(r.rows, [{ scryfall_id: ID.lightning, finish: "normal", language: "it", condition: "near_mint", binder: "Box", source: "scan", quantity: 1 }]);
    assert.deepEqual(keys(), ["02/normal/en/near_mint/Box/scan=2", "02/normal/it/near_mint/Box/scan=1"]);
    assert.equal(all().find((x) => x.language === "it").purchase_price, 1.5, "purchase price travels with the copy");
    const [log] = listEdits(ctx.db);
    assert.equal(log.id, r.edit_id);
    assert.equal(log.kind, "edit");
    assert.equal(log.actor, "app");
    assert.equal(log.copies, 1);
    assert.equal(log.undoable, true);
    assert.match(log.summary, /1 copy of Lightning Bolt: language en → it/);

    const u = undoEdit(ctx.db, r.edit_id);
    assert.equal(u.undone, true);
    assert.deepEqual(all().map((x) => [x.id, x.quantity, x.language]), [[id, 3, "en"]]);
    assert.ok(listEdits(ctx.db)[0].undone_at);
    assert.equal(listEdits(ctx.db)[0].undoable, false);
    assert.throws(() => undoEdit(ctx.db, r.edit_id), err(409, "undone"));
    assert.throws(() => undoEdit(ctx.db, 999), err(404));
  });

  test("merges into an existing row of the new key; undo splits it back (ids, prices)", async () => {
    const [a, b] = seed([[ID.lightning, 2, { condition: "played", price: 3 }], [ID.lightning, 1]]);
    const before = all();
    const r = await editCopies(ctx.db, { items: [item(ID.lightning, 2, { condition: "played" })], set: { condition: "near_mint" } });
    assert.deepEqual(keys(), ["02/normal/en/near_mint//scan=3"]);
    assert.equal(all()[0].id, b);
    assert.equal(all()[0].purchase_price, 3, "COALESCE merge took the price");
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(all(), before, "both rows exactly as before");
    assert.ok(before.some((x) => x.id === a));
  });

  test("all copies of a card ({oracle_id}) across rows and binders", async () => {
    seed([[ID.counterspell, 1, { binder: "A" }], [ID.counterspell7ed, 2, { binder: "B" }], [ID.sol, 1]]);
    const r = await editCopies(ctx.db, { items: [{ oracle_id: "o-counter" }], set: { condition: "good" } });
    assert.equal(r.edited_copies, 3);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(keys().filter((k) => k.includes("/good/")).length, 2);
    assert.match(listEdits(ctx.db)[0].summary, /3 copies of Counterspell: condition near_mint → good/);
  });

  test("ManaBox rows: confirm_master first, then source app + master app; undo restores the ManaBox row", async () => {
    const [id] = seed([[ID.sol, 3, { binder: "Box", source: "manabox" }]]);
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], set: { language: "de" } }),
      (e) => e.status === 409 && e.extra.code === "confirm_master" && e.extra.manabox_copies === 1);
    assert.equal(listEdits(ctx.db).length, 0, "nothing logged");
    const r = await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], set: { language: "de" }, confirm_master: true });
    assert.equal(r.converted_copies, 1);
    assert.equal(collectionMaster(ctx.db), "app");
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Box/app=1", "01/normal/en/near_mint/Box/manabox=2"]);
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(all().map((x) => [x.id, x.source, x.quantity]), [[id, "manabox", 3]]);
    assert.equal(collectionMaster(ctx.db), "app", "the master stays");
  });

  test("ManaBox rows with the app as master need no confirmation", async () => {
    setAppMeta(ctx.db, "collection_master", "app");
    seed([[ID.sol, 1, { source: "manabox" }]]);
    const r = await editCopies(ctx.db, { items: [item(ID.sol, 1, { source: "manabox" })], set: { finish: "foil" } });
    assert.equal(r.converted_copies, 1);
    assert.deepEqual(keys(), ["01/foil/en/near_mint//app=1"]);
  });

  test("printing: same oracle card only; finishes checked; language follows a foreign printing", async () => {
    seed([[ID.counterspell, 2], [ID.lightning, 1]]);
    const finishes = { [ID.counterspell7ed]: ["nonfoil"], [BOLT_IT.id]: ["nonfoil", "foil"] };
    const getPrinting = async (id) => (finishes[id] ? { id, lang: id === BOLT_IT.id ? "it" : "en", finishes: finishes[id] } : null);
    // Different card.
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.counterspell, 1)], set: { printing_id: ID.sol } }, { getPrinting }),
      (e) => e.status === 400 && /different card/.test(e.message));
    // Finish the new printing doesn't have.
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.counterspell, 1)], set: { printing_id: ID.counterspell7ed, finish: "foil" } }, { getPrinting }),
      (e) => e.status === 400 && /no foil finish/.test(e.message));
    const r = await editCopies(ctx.db, { items: [item(ID.counterspell, 1)], set: { printing_id: ID.counterspell7ed } }, { getPrinting });
    assert.match(r.summary, /printing MH2 267 → 7ED 67/);
    assert.deepEqual(keys().filter((k) => !k.startsWith("02")), ["05/normal/en/near_mint//scan=1", "06/normal/en/near_mint//scan=1"]);
    // Finish-only edit checked against the row's own printing.
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.counterspell7ed, 1)], set: { finish: "foil" } }, { getPrinting }), /no foil finish/);

    // A printing the cards table lacks is fetched (Scryfall) and inserted; its language is used.
    const fetchCards = fetchPool([BOLT_IT]);
    const it = await editCopies(ctx.db, { items: [item(ID.lightning, 1)], set: { printing_id: BOLT_IT.id } }, { getPrinting, fetchCards });
    assert.deepEqual(it.rows.map((x) => [x.scryfall_id, x.language]), [[BOLT_IT.id, "it"]]);
    assert.equal(ctx.db.prepare("SELECT lang FROM cards WHERE scryfall_id = ?").get(BOLT_IT.id).lang, "it");
    // Back to the English printing: the language came only from the printing, so it becomes en.
    const en = await editCopies(ctx.db, { items: [item(BOLT_IT.id, 1, { language: "it" })], set: { printing_id: ID.lightning } }, { getPrinting });
    assert.deepEqual(en.rows.map((x) => [x.scryfall_id, x.language]), [[ID.lightning, "en"]]);
  });

  test("offline: a new printing's card row comes from the index; unknown printing is 404", async () => {
    seed([[ID.lightning, 1]]);
    const indexRow = { id: BOLT_IT.id, oracle_id: "o-bolt", name: "Lightning Bolt", set_code: "m10", collector_number: "146", lang: "it", mana_cost: "{R}", finishes: ["nonfoil"] };
    const r = await editCopies(ctx.db, { items: [item(ID.lightning, 1)], set: { printing_id: BOLT_IT.id } },
      { getPrinting: (id) => (id === BOLT_IT.id ? indexRow : null), fetchCards: noFetch });
    assert.equal(r.rows[0].language, "it");
    assert.equal(ctx.db.prepare("SELECT fetched_at FROM cards WHERE scryfall_id = ?").get(BOLT_IT.id).fetched_at, "", "marked for re-fetch");
    await assert.rejects(editCopies(ctx.db, { items: [item(BOLT_IT.id, 1, { language: "it" })], set: { printing_id: "00000000-0000-0000-0000-0000000000ff" } },
      { fetchCards: noFetch }), err(404));
  });

  test("validation", async () => {
    seed([[ID.sol, 2]]);
    const items = [item(ID.sol, 1)];
    for (const set of [undefined, {}, { foo: 1 }, { language: "Italiano!" }, { condition: "mint-ish" }, { finish: "shiny" }, { printing_id: "x" }, { language: 3 }]) {
      await assert.rejects(editCopies(ctx.db, { items, set }), err(400), JSON.stringify(set));
    }
    await assert.rejects(editCopies(ctx.db, { items, set: { language: "de" }, actor: "root" }), err(400));
    await assert.rejects(editCopies(ctx.db, { items: [], set: { language: "de" } }), err(400));
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.sol, 3)], set: { language: "de" } }), err(409));
    await assert.rejects(editCopies(ctx.db, { items: [item(ID.serra, 1)], set: { language: "de" } }), err(404));
    // Condition spelled like ManaBox exports it; nonfoil = normal.
    const r = await editCopies(ctx.db, { items, set: { condition: "Light Played", finish: "nonfoil" } });
    assert.deepEqual(r.rows.map((x) => x.condition), ["light_played"]);
    // Nothing changes: no log entry.
    const noop = await editCopies(ctx.db, { items: [item(ID.sol, 1)], set: { language: "en" } });
    assert.deepEqual(noop, { edit_id: null, edited_copies: 0, converted_copies: 0, rows: [] });
    assert.equal(listEdits(ctx.db).length, 1);
  });

  test("actor claude is logged", async () => {
    seed([[ID.sol, 1]]);
    await editCopies(ctx.db, { items: [item(ID.sol, 1)], set: { condition: "good" }, actor: "claude" });
    assert.equal(listEdits(ctx.db)[0].actor, "claude");
  });
});

describe("deleteCopies", () => {
  test("needs confirm:true; partial delete; empty binder stays; undo", async () => {
    const [id] = seed([[ID.sol, 2, { binder: "Trade" }]]);
    assert.throws(() => deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Trade" })] }), err(400));
    assert.throws(() => deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Trade" })], confirm: "yes" }), err(400));
    const one = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Trade" })], confirm: true });
    assert.equal(one.deleted_copies, 1);
    const two = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Trade" })], confirm: true });
    assert.equal(all().length, 0);
    assert.deepEqual(listBinders(ctx.db).binders.map((b) => [b.name, b.empty]), [["Trade", true]]);
    const log = listEdits(ctx.db);
    assert.deepEqual(log.map((e) => [e.kind, e.copies, e.undoable]), [["delete", 1, true], ["delete", 1, false]], "older one waits for the newer");
    assert.match(log[0].summary, /Deleted 1 copy: 1× Sol Ring/);
    assert.throws(() => undoEdit(ctx.db, one.edit_id), err(409, "conflict"));
    undoEdit(ctx.db, two.edit_id);
    undoEdit(ctx.db, one.edit_id);
    assert.deepEqual(all().map((x) => [x.id, x.quantity, x.binder]), [[id, 2, "Trade"]]);
  });

  test("ManaBox rows: 409 manabox_rows while ManaBox is master; confirm_master flips it", async () => {
    seed([[ID.sol, 2, { source: "manabox" }], [ID.lightning, 1]]);
    const items = [item(ID.sol, 2), item(ID.lightning, 1)];
    assert.throws(() => deleteCopies(ctx.db, { items, confirm: true }), (e) => e.status === 409 && e.extra.code === "manabox_rows" && e.extra.manabox_copies === 2);
    assert.equal(all().length, 2, "nothing deleted");
    const r = deleteCopies(ctx.db, { items, confirm: true, confirm_master: true });
    assert.equal(r.deleted_copies, 3);
    assert.equal(r.collection_master, "app");
    assert.equal(all().length, 0);
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(keys(), ["01/normal/en/near_mint//manabox=2", "02/normal/en/near_mint//scan=1"]);
  });

  test("expected_copies: a count that no longer matches deletes nothing (409 changed)", () => {
    seed([[ID.lightning, 2, { binder: "Box" }]]);
    const items = [{ oracle_id: "o-bolt", from_binder: "Box" }];
    const oracle = ctx.db.prepare("SELECT oracle_id FROM cards WHERE scryfall_id = ?").get(ID.lightning).oracle_id;
    items[0].oracle_id = oracle;
    // 3 more copies arrive after the user counted 2.
    seed([[ID.lightning, 3, { binder: "Box", language: "de" }]]);
    assert.throws(() => deleteCopies(ctx.db, { items, confirm: true, expected_copies: 2 }),
      (e) => e.status === 409 && e.extra.code === "changed" && e.extra.copies === 5);
    assert.equal(all().reduce((n, r) => n + r.quantity, 0), 5, "nothing deleted");
    assert.equal(listEdits(ctx.db).length, 0);
    assert.throws(() => deleteCopies(ctx.db, { items, confirm: true, expected_copies: -1 }), err(400));
    assert.equal(deleteCopies(ctx.db, { items, confirm: true, expected_copies: 5 }).deleted_copies, 5);
  });

  test("a binder's 'Delete cards' is logged and undoable (also ManaBox copies with confirm_master)", () => {
    const ids = seed([[ID.sol, 2, { binder: "A", source: "manabox" }], [ID.lightning, 1, { binder: "A" }]]);
    ctx.db.prepare("INSERT INTO binders (name, origin, created_at) VALUES ('A', 'manabox', '2026-01-01')").run();
    assert.throws(() => deleteBinder(ctx.db, "A", { cards: "delete" }), err(409, "manabox_rows"));
    const r = deleteBinder(ctx.db, "A", { cards: "delete", confirm_master: true });
    assert.equal(r.deleted_copies, 3);
    assert.ok(r.edit_id);
    assert.equal(all().length, 0);
    const [log] = listEdits(ctx.db);
    assert.deepEqual([log.kind, log.copies, log.undoable], ["delete", 3, true]);
    assert.match(log.summary, /Deleted binder "A" with 3 copies: 2× Sol Ring, 1× Lightning Bolt/);
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(all().map((x) => [x.id, x.quantity, x.binder, x.source]), [[ids[0], 2, "A", "manabox"], [ids[1], 1, "A", "scan"]]);
    assert.ok(listBinders(ctx.db).binders.some((b) => b.name === "A"), "the binder is back");
    // An empty binder: nothing to log.
    ctx.db.prepare("INSERT INTO binders (name, origin, created_at) VALUES ('Empty', 'app', '2026-01-01')").run();
    assert.equal(deleteBinder(ctx.db, "Empty", { cards: "delete" }).edit_id, null);
  });

  test("undoing a binder's 'Delete cards' restores the deck box (decks.box_binder)", () => {
    seed([[ID.sol, 2, { binder: "Red box", source: "app" }]]);
    ctx.db.prepare("INSERT INTO binders (name, origin, created_at) VALUES ('Red box', 'app', '2026-01-01')").run();
    const deck = Number(ctx.db.prepare("INSERT INTO decks (name, box_binder) VALUES ('X', 'Red box')").run().lastInsertRowid);
    const box = () => ctx.db.prepare("SELECT box_binder FROM decks WHERE id = ?").get(deck).box_binder;
    const r = deleteBinder(ctx.db, "Red box", { cards: "delete" });
    assert.equal(box(), null);
    undoEdit(ctx.db, r.edit_id);
    assert.equal(box(), "Red box");
    assert.equal(all()[0].binder, "Red box");
  });

  test("scan rows can be deleted while ManaBox is the master", () => {
    seed([[ID.lightning, 1]]);
    assert.equal(deleteCopies(ctx.db, { items: [item(ID.lightning, 1)], confirm: true }).deleted_copies, 1);
  });
});

describe("undo conflicts", () => {
  test("a later move makes the undo a 409 and changes nothing", async () => {
    seed([[ID.sol, 2, { binder: "A" }]]);
    const r = await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "A" })], set: { language: "de" } });
    moveCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "A", language: "de" })], to_binder: "B", create: true });
    const snapshot = all();
    assert.equal(listEdits(ctx.db)[0].undoable, false);
    assert.match(listEdits(ctx.db)[0].reason, /changed since/);
    assert.throws(() => undoEdit(ctx.db, r.edit_id), err(409, "conflict"));
    assert.deepEqual(all(), snapshot);
    // Moving it back makes the rows match again: undo works.
    moveCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "B", language: "de" })], to_binder: "A" });
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/A/scan=2"]);
  });

  test("a newer edit of the same rows must be undone first", async () => {
    seed([[ID.sol, 1]]);
    const a = await editCopies(ctx.db, { items: [item(ID.sol, 1)], set: { language: "de" } });
    const b = await editCopies(ctx.db, { items: [item(ID.sol, 1, { language: "de" })], set: { condition: "good" } });
    assert.throws(() => undoEdit(ctx.db, a.edit_id), (e) => e.status === 409 && /newer change/.test(e.message));
    undoEdit(ctx.db, b.edit_id);
    undoEdit(ctx.db, a.edit_id);
    assert.deepEqual(keys(), ["01/normal/en/near_mint//scan=1"]);
  });

  test("unrelated newer edits don't block", async () => {
    seed([[ID.sol, 1], [ID.lightning, 1]]);
    const a = await editCopies(ctx.db, { items: [item(ID.sol, 1)], set: { language: "de" } });
    await editCopies(ctx.db, { items: [item(ID.lightning, 1)], set: { language: "de" } });
    assert.equal(listEdits(ctx.db)[1].undoable, true);
    undoEdit(ctx.db, a.edit_id);
  });

  test("undo restores a row id even when an insert reused it", async () => {
    const [id] = seed([[ID.sol, 1]]);
    const r = await editCopies(ctx.db, { items: [item(ID.sol, 1)], set: { language: "de" } });
    assert.equal(all()[0].id, id, "INTEGER PRIMARY KEY reused the max id for the new row");
    undoEdit(ctx.db, r.edit_id);
    assert.deepEqual(all().map((x) => [x.id, x.language]), [[id, "en"]]);
  });
});

describe("deck allocation after edits", () => {
  test("owned counts stay per oracle card across printing edits; delete makes it missing", async () => {
    seed([[ID.counterspell, 2]]);
    const deckId = saveDeckRows(ctx.db, { name: "Blue", status: "built", rows: [{ name: "Counterspell", scryfall_id: ID.counterspell, quantity: 2, board: "main" }] });
    const card = () => deckDetail(ctx.db, deckId).cards.find((c) => c.name === "Counterspell");
    assert.equal(card().owned, 2);
    await editCopies(ctx.db, { items: [item(ID.counterspell, 2)], set: { printing_id: ID.counterspell7ed, language: "de" } });
    assert.equal(card().owned, 2);
    assert.equal(card().to_buy, 0);
    const d = deleteCopies(ctx.db, { items: [item(ID.counterspell7ed, 1, { language: "de" })], confirm: true });
    assert.equal(card().owned, 1);
    assert.equal(card().to_buy, 1);
    undoEdit(ctx.db, d.edit_id);
    assert.equal(card().to_buy, 0);
  });
});

// ManaBox CSV (as test/manabox.test.js).
const HEADER = "Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency";
const csvRow = (binder, name, set, num, qty, id) => [binder, "binder", `"${name}"`, set, "", num, "normal", "", qty, "", id, "", "false", "false", "near_mint", "en", ""].join(",");
const FILE = [HEADER, csvRow("Box", "Sol Ring", "c21", "263", "3", ID.sol)].join("\n") + "\n";
const csvRowX = (binder, name, set, num, qty, id, { language = "en", condition = "near_mint" } = {}) =>
  [binder, "binder", `"${name}"`, set, "", num, "normal", "", qty, "", id, "", "false", "false", condition, language, ""].join(",");

describe("ManaBox imports after edits / deletes", () => {
  let stub;
  beforeEach(() => { stub = stubScryfall(); });
  afterEach(() => stub.restore());
  const total = () => ctx.db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM collection").get().n;

  test("edited ManaBox copy: delta adds nothing; replace nets it against its old line", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Box/app=1", "01/normal/en/near_mint/Box/manabox=2"]);
    const delta = await importManaBoxCsv(ctx.db, FILE);
    assert.equal(delta.mode, "delta", "master is app now");
    assert.equal(delta.added_copies, 0);
    assert.equal(delta.decreased_copies, 0);
    assert.equal(total(), 3);
    // A replace re-syncs to the file: the edit log says the de app copy came from ManaBox's en line.
    const replace = await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.equal(replace.kept_app_copies, 1);
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Box/app=1", "01/normal/en/near_mint/Box/manabox=2"]);
  });

  test("switch back to ManaBox + replace: edited copies (also edited twice) are not counted twice", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    moveCopies(ctx.db, { items: [item(ID.sol, 3, { binder: "Box" })], to_binder: "Shelf", create: true, confirm_master: true });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Shelf", source: "app" })], set: { condition: "played" } });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Shelf", source: "app", condition: "played" })], set: { language: "de" } });
    setCollectionMaster(ctx.db, "manabox");
    const r = await importManaBoxCsv(ctx.db, FILE);
    assert.equal(r.mode, "replace");
    assert.equal(r.kept_app_copies, 3);
    assert.equal(total(), 3);
    assert.deepEqual(keys(), ["01/normal/de/played/Shelf/app=1", "01/normal/en/near_mint/Shelf/app=2"]);
    // Undoing the edits brings the copy back to the line it came from; still 3.
    for (const e of listEdits(ctx.db)) undoEdit(ctx.db, e.id);
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.equal(total(), 3);
  });

  test("the same fix made in ManaBox too: delta nets it instead of adding a copy", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    const e1 = await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    // ManaBox: 2 en + 1 de (same fix there).
    const fixed = [HEADER, csvRow("Box", "Sol Ring", "c21", "263", "2", ID.sol), csvRowX("Box", "Sol Ring", "c21", "263", "1", ID.sol, { language: "de" })].join("\n") + "\n";
    const delta = await importManaBoxCsv(ctx.db, fixed);
    assert.equal(delta.mode, "delta");
    assert.equal(delta.added_copies, 0);
    assert.equal(delta.decreased_copies, 0);
    assert.equal(delta.matched_edit_copies, 1);
    assert.match(delta.matched_edits[0].message, /Already changed in the app: Sol Ring/);
    assert.equal(total(), 3);
    // Again: nothing changes; the edit can no longer be undone (ManaBox lists it like this now).
    assert.equal((await importManaBoxCsv(ctx.db, fixed)).added_copies, 0);
    assert.equal(total(), 3);
    const [log] = listEdits(ctx.db);
    assert.equal(log.id, e1.edit_id);
    assert.equal(log.undoable, false);
    assert.match(log.reason, /ManaBox import already counted/);
    // A replace with that file nets exactly.
    await importManaBoxCsv(ctx.db, fixed, { mode: "replace", confirm_replace: true });
    assert.equal(total(), 3);

    // Condition fix: edit en NM -> LP, ManaBox the same; a real new copy on top is still added.
    const e2 = await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { condition: "light_played" } });
    assert.ok(e2.edit_id);
    const lp = [HEADER, csvRow("Box", "Sol Ring", "c21", "263", "1", ID.sol), csvRowX("Box", "Sol Ring", "c21", "263", "1", ID.sol, { language: "de" }),
      csvRowX("Box", "Sol Ring", "c21", "263", "2", ID.sol, { condition: "light_played" })].join("\n") + "\n";
    const d2 = await importManaBoxCsv(ctx.db, lp);
    assert.equal(d2.matched_edit_copies, 1);
    assert.equal(d2.added_copies, 1, "the second LP copy is new");
    assert.equal(d2.decreased_copies, 0);
    assert.equal(total(), 4);
  });

  test("condition-only and same-key edits: replace nets app rows per printing key", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    // Moving (not editing) keeps the printing key: replace nets it.
    moveCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], to_binder: "", confirm_master: true });
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.equal(total(), 3);
  });

  const fileOf = (...rows) => [HEADER, ...rows].join("\n") + "\n";
  const solEn = (q) => csvRow("Box", "Sol Ring", "c21", "263", String(q), ID.sol);
  const solDe = (q) => csvRowX("Box", "Sol Ring", "c21", "263", String(q), ID.sol, { language: "de" });

  test("deleted ManaBox copy: neither delta nor replace brings it back; undo still works", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    const d = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
    assert.equal(total(), 2);
    await importManaBoxCsv(ctx.db, FILE);
    assert.equal(total(), 2);
    assert.equal(listEdits(ctx.db)[0].undoable, true, "delta changed nothing");
    const r = await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.equal(r.deleted_in_app_copies, 1);
    assert.equal(r.matched_edit_copies, 0);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=2"]);
    // Again: still 2 (the delete stays outstanding until ManaBox drops the copy too).
    assert.equal((await importManaBoxCsv(ctx.db, FILE, { mode: "replace" })).deleted_in_app_copies, 1);
    assert.equal(total(), 2);
    // The rows look as the delete left them: undo brings the copy back, and replace keeps it.
    assert.equal(listEdits(ctx.db)[0].undoable, true);
    undoEdit(ctx.db, d.edit_id);
    assert.equal(total(), 3);
    assert.equal((await importManaBoxCsv(ctx.db, FILE, { mode: "replace" })).deleted_in_app_copies, 0);
    assert.equal(total(), 3);
  });

  test("deleting the only copy of a line: replace does not resurrect it", async () => {
    await importManaBoxCsv(ctx.db, fileOf(solEn(3), solDe(1)), { mode: "replace" });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", language: "de" })], confirm: true, confirm_master: true });
    await importManaBoxCsv(ctx.db, fileOf(solEn(3), solDe(1)), { mode: "replace" });
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=3"]);
  });

  test("ManaBox deletes it too: replace counts the delete once (netted, no longer undoable)", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    const d = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
    const r = await importManaBoxCsv(ctx.db, fileOf(solEn(2)), { mode: "replace" });
    assert.equal(r.matched_edit_copies, 1);
    assert.equal(r.deleted_in_app_copies, 0);
    assert.match(r.matched_edits[0].message, /Already deleted in the app: Sol Ring \(1\)/);
    assert.equal(total(), 2);
    assert.equal((await importManaBoxCsv(ctx.db, fileOf(solEn(2)), { mode: "replace" })).deleted_in_app_copies, 0);
    assert.equal(total(), 2, "not subtracted a second time");
    assert.throws(() => undoEdit(ctx.db, d.edit_id), err(409, "conflict"));
    assert.match(listEdits(ctx.db)[0].reason, /ManaBox import already counted/);
    // A new purchase in ManaBox afterwards is loaded normally.
    await importManaBoxCsv(ctx.db, fileOf(solEn(3)), { mode: "replace" });
    assert.equal(total(), 3);
  });

  test("ManaBox deletes it too: delta does not report it as a decrease", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
    const r = await importManaBoxCsv(ctx.db, fileOf(solEn(2)));
    assert.equal(r.mode, "delta");
    assert.equal(r.decreased_copies, 0);
    assert.equal(r.matched_edit_copies, 1);
    assert.match(r.matched_edits[0].message, /Already deleted in the app/);
    assert.equal(total(), 2);
    // ManaBox drops one more: that one is reported.
    const r2 = await importManaBoxCsv(ctx.db, fileOf(solEn(1)));
    assert.equal(r2.decreased_copies, 1);
    assert.equal(r2.matched_edit_copies, 0);
    await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "replace" });
    assert.equal(total(), 1);
  });

  test("edit then delete of the same ManaBox copy: replace leaves it out", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "app", language: "de" })], confirm: true });
    assert.equal(total(), 2);
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=2"]);
  });

  test("edit then delete; ManaBox makes only the edit: neither delta nor replace brings it back", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "app", language: "de" })], confirm: true });
    const fixed = fileOf(solEn(2), solDe(1));
    const d = await importManaBoxCsv(ctx.db, fixed);
    assert.equal(d.added_copies, 0);
    assert.equal(d.matched_edit_copies, 1);
    assert.equal(total(), 2);
    await importManaBoxCsv(ctx.db, fixed, { mode: "replace" });
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=2"], "the de line is the deleted copy");
  });

  test("edit then delete; ManaBox makes only the edit, straight into a replace", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "app", language: "de" })], confirm: true });
    const r = await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace" });
    assert.equal(r.matched_edit_copies, 1);
    assert.equal(r.deleted_in_app_copies, 1);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=2"]);
  });

  // An app row holding one edited copy (origin en) and one moved ManaBox de copy: each copy keeps
  // its own origin, so neither the edit nor the delete charges both copies to the en line.
  const mixedRow = async () => {
    await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    moveCopies(ctx.db, { items: [item(ID.sol, 2, { binder: "Box", language: "de" })], to_binder: "Shelf", create: true });
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Shelf/app=2", "01/normal/en/near_mint/Box/manabox=1"]);
  };

  test("mixed-origin app row edited: replace keeps the real en copy", async () => {
    await mixedRow();
    const e = await editCopies(ctx.db, { items: [item(ID.sol, 2, { binder: "Shelf", source: "app", language: "de" })], set: { condition: "played" } });
    const moves = loggedMoves(e.edit_id).map((m) => `${m.origin.split("|").slice(2).join("|")}>${m.n}`).sort();
    assert.deepEqual(moves, ["de|near_mint>1", "en|near_mint>1"]);
    await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace", confirm_replace: true });
    assert.deepEqual(keys(), ["01/normal/de/played/Shelf/app=2", "01/normal/en/near_mint/Box/manabox=1"]);
    await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)));
    assert.equal(total(), 3);
  });

  test("mixed-origin app row deleted: replace neither resurrects it nor drops the en copy", async () => {
    await mixedRow();
    const d = deleteCopies(ctx.db, { items: [item(ID.sol, 2, { binder: "Shelf", source: "app", language: "de" })], confirm: true });
    const moves = loggedMoves(d.edit_id).map((m) => `${m.origin.split("|").slice(2).join("|")}>${m.n}`).sort();
    assert.deepEqual(moves, ["de|near_mint>1", "en|near_mint>1"]);
    await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace", confirm_replace: true });
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=1"]);
  });

  test("edit to a key ManaBox already lists: replace keeps the edit (no key swap)", async () => {
    await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace" });
    await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    const r = await importManaBoxCsv(ctx.db, fileOf(solEn(2), solDe(1)), { mode: "replace" });
    assert.equal(r.kept_app_copies, 1);
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Box/app=1", "01/normal/de/near_mint/Box/manabox=1", "01/normal/en/near_mint/Box/manabox=1"]);
  });

  test("the same fix made in ManaBox, counted by a replace: no longer undoable", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    const e = await editCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box", source: "manabox" })], set: { language: "de" }, confirm_master: true });
    const fixed = fileOf(solEn(2), solDe(1));
    const r = await importManaBoxCsv(ctx.db, fixed, { mode: "replace" });
    assert.equal(r.matched_edit_copies, 1);
    assert.deepEqual(keys(), ["01/normal/de/near_mint/Box/app=1", "01/normal/en/near_mint/Box/manabox=2"]);
    assert.throws(() => undoEdit(ctx.db, e.edit_id), err(409, "conflict"));
    await importManaBoxCsv(ctx.db, fixed, { mode: "replace" });
    assert.equal(total(), 3);
  });

  test("a binder's 'Delete cards' is not resurrected by replace or delta", async () => {
    await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    const r = deleteBinder(ctx.db, "Box", { cards: "delete", confirm_master: true });
    assert.equal(r.deleted_copies, 3);
    const rep = await importManaBoxCsv(ctx.db, FILE, { mode: "replace" });
    assert.equal(rep.deleted_in_app_copies, 3);
    assert.equal(total(), 0);
    assert.equal((await importManaBoxCsv(ctx.db, FILE)).added_copies, 0);
    assert.equal(total(), 0);
    assert.ok(!listBinders(ctx.db).binders.some((b) => b.name === "Box"), "the binder is not recreated");
    // ManaBox gains a copy: only that one is new.
    await importManaBoxCsv(ctx.db, fileOf(solEn(4)), { mode: "replace" });
    assert.equal(total(), 1);
  });

  const solIn = (binder, q) => csvRow(binder, "Sol Ring", "c21", "263", String(q), ID.sol);
  const loggedMoves = (editId) => JSON.parse(ctx.db.prepare("SELECT changes FROM collection_edits WHERE id = ?").get(editId).changes).moves;

  test("deleting a surplus copy (add-import duplicate) logs nothing: replace keeps the genuine one", async () => {
    await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "replace" });
    await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "add" });
    assert.equal(total(), 2);
    const d = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
    assert.equal(loggedMoves(d.edit_id), undefined, "ManaBox lists 1 and 1 is left: nothing backed");
    const r = await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "replace", confirm_replace: true });
    assert.equal(r.deleted_in_app_copies, 0);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=1"]);
    // Deleting the genuine one too is logged (1 of 1) and stays out.
    const d2 = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true });
    assert.equal(loggedMoves(d2.edit_id)[0].n, 1);
    assert.equal((await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "replace" })).deleted_in_app_copies, 1);
    assert.equal(total(), 0);
  });

  test("deleting a surplus app copy, then a ManaBox purchase: delta and replace agree", async () => {
    await importManaBoxCsv(ctx.db, fileOf(solEn(2)), { mode: "replace" });
    moveCopies(ctx.db, { items: [{ printing_id: ID.sol }], to_binder: "Shelf", create: true, confirm_master: true });
    const sold = await importManaBoxCsv(ctx.db, fileOf(solEn(1)), { mode: "replace", confirm_replace: true });
    assert.equal(sold.decreased_copies, 1);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Shelf/app=2"]);
    const d = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Shelf", source: "app" })], confirm: true });
    assert.equal(loggedMoves(d.edit_id), undefined, "ManaBox no longer lists that copy");
    const delta = await importManaBoxCsv(ctx.db, fileOf(solEn(2)));
    assert.equal(delta.added_copies, 1);
    assert.equal(total(), 2);
    const rep = await importManaBoxCsv(ctx.db, fileOf(solEn(2)), { mode: "replace", confirm_replace: true });
    assert.equal(rep.deleted_in_app_copies, 0);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=1", "01/normal/en/near_mint/Shelf/app=1"]);
    // Straight into a replace (no delta in between): the same.
    await importManaBoxCsv(ctx.db, fileOf(solEn(2)), { mode: "replace", confirm_replace: true });
    assert.equal(total(), 2);
  });

  test("a sale in another ManaBox binder is not the app delete (replace and delta)", async () => {
    for (const mode of ["replace", "delta"]) {
      ctx.db.exec("DELETE FROM collection; DELETE FROM collection_edits; DELETE FROM manabox_snapshot");
      setCollectionMaster(ctx.db, "manabox");
      await importManaBoxCsv(ctx.db, fileOf(solIn("Box", 2), solIn("Trade", 1)), { mode: "replace" });
      const d = deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
      assert.equal(total(), 2);
      const r = await importManaBoxCsv(ctx.db, fileOf(solIn("Box", 2)), { mode, confirm_replace: true });
      assert.equal(r.matched_edit_copies, 0, `${mode}: the Trade sale is not the Box delete`);
      if (mode === "replace") {
        assert.equal(r.deleted_in_app_copies, 1);
        assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=1"], "the deleted copy stays deleted");
      } else {
        assert.equal(r.decreased_copies, 1, "the Trade sale is reported");
      }
      assert.equal(listEdits(ctx.db).find((e) => e.id === d.edit_id).undoable, true);
      // Now ManaBox drops the Box copy too: that is the delete.
      const r2 = await importManaBoxCsv(ctx.db, fileOf(solIn("Box", 1)), { mode, confirm_replace: true });
      assert.equal(r2.matched_edit_copies, 1, mode);
      if (mode === "replace") assert.deepEqual(keys(), ["01/normal/en/near_mint/Box/manabox=1"]);
    }
  });

  test("a delete still nets a drop in another binder when ManaBox moved the line away", async () => {
    await importManaBoxCsv(ctx.db, fileOf(solIn("Box", 2)), { mode: "replace" });
    deleteCopies(ctx.db, { items: [item(ID.sol, 1, { binder: "Box" })], confirm: true, confirm_master: true });
    const r = await importManaBoxCsv(ctx.db, fileOf(solIn("Trade", 1)), { mode: "replace", confirm_replace: true });
    assert.equal(r.matched_edit_copies, 1);
    assert.deepEqual(keys(), ["01/normal/en/near_mint/Trade/manabox=1"]);
  });

  test("deleting scan copies logs no ManaBox moves", () => {
    seed([[ID.lightning, 2]]);
    const d = deleteCopies(ctx.db, { items: [item(ID.lightning, 1)], confirm: true });
    const ch = JSON.parse(ctx.db.prepare("SELECT changes FROM collection_edits WHERE id = ?").get(d.edit_id).changes);
    assert.equal(ch.moves, undefined);
  });
});

describe("legacy relanguage entries", () => {
  const now = new Date().toISOString();

  test("stay undoable: the copies and the scans' stored printing and updated_at come back", () => {
    upsertCards(ctx.db, [normalizeCard(BOLT_IT)]);
    seed([[ID.lightning, 1, { binder: "Scans" }]]);
    ctx.db.prepare(
      `INSERT INTO scans (id, created_at, updated_at, status, printing_id, store_printing_id, oracle_id, name, finish, condition, quantity,
                          lang_detected, store_lang, committed_at, committed_to)
       VALUES (5, ?, '2026-01-01T00:00:00.000Z', 'committed', ?, ?, 'o-bolt', 'Lightning Bolt', 'normal', 'near_mint', 1, 'it', 'en', ?, ?)`,
    ).run(now, BOLT_IT.id, ID.lightning, now, JSON.stringify({ type: "binder", name: "Scans" }));
    const before = all();
    // What the removed data fix wrote: the scan's copy moved to the detected (Italian) printing.
    const editId = transaction(ctx.db, () => {
      const t = tracker(ctx.db);
      const row = ctx.db.prepare("SELECT * FROM collection WHERE scryfall_id = ?").get(ID.lightning);
      t.touch(row);
      t.touch({ ...row, scryfall_id: BOLT_IT.id, language: "it" });
      ctx.db.prepare("UPDATE collection SET scryfall_id = ?, language = 'it' WHERE id = ?").run(BOLT_IT.id, row.id);
      ctx.db.prepare("UPDATE scans SET store_printing_id = ?, store_lang = 'it', updated_at = ? WHERE id = 5").run(BOLT_IT.id, now);
      return writeLog(ctx.db, {
        kind: "relanguage", actor: "maintenance", summary: "Stored 1 scanned copy (1 scan) in the scanned language (IT)", copies: 1, rows: t.finish(),
        scans: [{ id: 5, before: { store_printing_id: ID.lightning, store_lang: "en", updated_at: "2026-01-01T00:00:00.000Z" }, after: { store_printing_id: BOLT_IT.id, store_lang: "it" } }],
      });
    });
    const [log] = listEdits(ctx.db);
    assert.deepEqual([log.id, log.kind, log.actor, log.undoable], [editId, "relanguage", "maintenance", true]);
    undoEdit(ctx.db, editId);
    assert.deepEqual(all(), before);
    assert.deepEqual({ ...ctx.db.prepare("SELECT store_printing_id, store_lang, updated_at FROM scans WHERE id = 5").get() },
      { store_printing_id: ID.lightning, store_lang: "en", updated_at: "2026-01-01T00:00:00.000Z" });
  });

  test("commitScans records owned + binder for deck targets", async () => {
    const stub = stubScryfall();
    try {
      for (const [id, owned] of [[11, false], [12, true]]) {
        ctx.db.prepare(
          `INSERT INTO scans (id, created_at, updated_at, status, printing_id, store_printing_id, oracle_id, name, finish, condition, quantity, store_lang, match_status)
           VALUES (?, ?, ?, 'staged', ?, ?, 'o-bolt', 'Lightning Bolt', 'normal', 'near_mint', 1, 'en', 'auto')`,
        ).run(id, now, now, ID.lightning, ID.lightning);
        await commitScans(ctx.db, [id], { type: "deck", name: "Burn", create: id === 11, board: "main", owned });
      }
      const to = (id) => JSON.parse(ctx.db.prepare("SELECT committed_to FROM scans WHERE id = ?").get(id).committed_to);
      assert.equal(to(11).owned, false);
      assert.equal(to(11).binder, null);
      assert.equal(to(12).owned, true);
      assert.equal(to(12).binder, "Burn");
    } finally { stub.restore(); }
  });
});

describe("migration v8", () => {
  test("from a v7 database with data: edit log added, data intact, idempotent", async () => {
    seed([[ID.sol, 2, { binder: "Box", source: "manabox" }], [ID.lightning, 1, { binder: "Scans" }]]);
    ctx.db.prepare("INSERT INTO decks (name, source, status) VALUES ('D', 'manual', 'built')").run();
    ctx.db.prepare("INSERT INTO meta (key, value) VALUES ('collection_master', 'manabox')").run();
    // Downgrade to v7: no collection_edits table.
    ctx.db.exec("DROP TABLE collection_edits; PRAGMA user_version = 7");
    const rows = all();
    ctx.db.close();
    const raw = new DatabaseSync(ctx.file);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'collection_edits'").get().n, 0);
    raw.close();

    for (let i = 0; i < 2; i++) {
      const db = openDb(ctx.file);
      assert.ok(SCHEMA_VERSION >= 8);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      assert.deepEqual(db.prepare("SELECT * FROM collection ORDER BY id").all().map((r) => ({ ...r })), rows);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM decks").get().n, 1);
      assert.deepEqual(listEdits(db), []);
      // Re-running v8 on a table that exists is harmless.
      db.exec("PRAGMA user_version = 7");
      db.close();
    }
    const db = openDb(ctx.file);
    try {
      const r = await editCopies(db, { items: [item(ID.lightning, 1, { binder: "Scans" })], set: { language: "ja" } });
      assert.equal(listEdits(db)[0].id, r.edit_id);
    } finally { db.close(); }
  });
});
