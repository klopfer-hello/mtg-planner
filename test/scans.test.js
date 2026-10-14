// Scanner staging list, binders and commits (lib/scans.js), the collection
// `source` migration (lib/db.js) and ManaBox replace semantics. Offline:
// Scryfall's /cards/collection is stubbed, the card index is a small stub.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { importManaBoxCsv } from "../lib/manabox.js";
import { deckDetail } from "../lib/decks.js";
import {
  ScanError, commitScans, deleteBinder, deleteScan, exportCalibration, getScan, incrementScan, listBinders, listScans,
  recordTruth, renameBinder, scanImagePath, scanStripPath, stageScan, undoLast, updateScan,
} from "../lib/scans.js";
import { ID, SCRYFALL_CARDS, seedCards, seedCollection, stubScryfall, tempDb } from "./fixtures.js";

// Index-shaped printings for fixture cards (same ids, so the Scryfall stub resolves them).
const fx = (id) => SCRYFALL_CARDS.find((c) => c.id === id);
const asPrinting = (c, extra = {}) => ({
  id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: null, lang: c.lang, set_code: c.set, set_name: c.set_name,
  collector_number: c.collector_number, rarity: c.rarity, finishes: ["nonfoil", "foil"], faces: [],
  image_small: `https://cards.scryfall.io/small/${c.id}.jpg`, image_normal: `https://cards.scryfall.io/normal/${c.id}.jpg`,
  type_line: c.type_line, mana_cost: c.mana_cost, ...extra,
});
const BOLT = asPrinting(fx(ID.lightning));
const SOL = asPrinting(fx(ID.sol));
const SERRA = asPrinting(fx(ID.serra), { finishes: ["nonfoil"] });
// A German Lightning Bolt that only the local index knows (not in the Scryfall stub).
const BOLT_DE = { ...BOLT, id: "aaaaaaaa-0000-0000-0000-000000000146", lang: "de", printed_name: "Blitzschlag" };

const PRINTINGS = [BOLT, SOL, SERRA, BOLT_DE];
const index = {
  getPrinting: (_i, id) => PRINTINGS.find((p) => p.id === id) ?? null,
  storagePrinting: (_i, p, lang) => PRINTINGS.find((x) => x.set_code === p.set_code && x.collector_number === p.collector_number && x.lang === lang)
    || PRINTINGS.find((x) => x.set_code === p.set_code && x.collector_number === p.collector_number && x.lang === "en") || p,
};
const idx = {};

const result = (printing, o = {}) => ({
  status: "auto", printing, store: o.store ?? printing, finish: "normal", finishSource: "star", method: "ocr", confidence: 0.95,
  candidates: [{ id: printing.id, name: printing.name }], variants: [], features: { collector: { raw: "x" } }, timings: { total: 5 }, ...o,
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let ctx, imageDir, stub;
beforeEach(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-img-"));
  stub = stubScryfall();
});
afterEach(() => {
  stub.restore();
  ctx.cleanup();
  rmSync(imageDir, { recursive: true, force: true });
});

const stage = (r, o = {}) => stageScan(ctx.db, r, { imageDir, ...o });
const commit = (ids, target, o = {}) => commitScans(ctx.db, ids, target, { idx, index, imageDir, ...o });

describe("migration", () => {
  test("old collection table gains source='manabox' and the wider unique key; rows preserved", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-mig-"));
    const file = path.join(dir, "old.db");
    try {
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE cards (scryfall_id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT NOT NULL, set_code TEXT, set_name TEXT,
          collector_number TEXT, lang TEXT, rarity TEXT, type_line TEXT, mana_cost TEXT, cmc REAL, colors TEXT NOT NULL DEFAULT '',
          color_identity TEXT NOT NULL DEFAULT '', oracle_text TEXT, keywords TEXT, legalities TEXT, prices TEXT, image_small TEXT,
          image_normal TEXT, scryfall_uri TEXT, fetched_at TEXT NOT NULL);
        CREATE TABLE collection (id INTEGER PRIMARY KEY, scryfall_id TEXT NOT NULL REFERENCES cards(scryfall_id),
          finish TEXT NOT NULL DEFAULT 'normal', language TEXT NOT NULL DEFAULT 'en', condition TEXT NOT NULL DEFAULT 'near_mint',
          binder TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL, purchase_price REAL, purchase_currency TEXT,
          UNIQUE (scryfall_id, finish, language, condition, binder));
        INSERT INTO cards (scryfall_id, oracle_id, name, fetched_at) VALUES ('c1', 'o1', 'Card One', 'x'), ('c2', 'o2', 'Card Two', 'x');
        INSERT INTO collection (scryfall_id, finish, language, binder, quantity, purchase_price) VALUES
          ('c1', 'normal', 'en', 'Trade', 3, 1.5), ('c2', 'foil', 'de', '', 1, NULL);
      `);
      old.close();

      const db = openDb(file);
      const cols = db.prepare("PRAGMA table_info(collection)").all().map((c) => c.name);
      assert.ok(cols.includes("source"));
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
      assert.deepEqual(db.prepare("SELECT name, origin FROM binders").all().map((r) => ({ ...r })), [{ name: "Trade", origin: "manabox" }], "v4 binders backfill");
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'meta'").get(), "v3 meta table");
      assert.ok(db.prepare("PRAGMA table_info(scans)").all().some((c) => c.name === "undo"));
      const rows = db.prepare("SELECT scryfall_id, finish, language, binder, quantity, purchase_price, source FROM collection ORDER BY id").all();
      assert.deepEqual(rows.map((r) => ({ ...r })), [
        { scryfall_id: "c1", finish: "normal", language: "en", binder: "Trade", quantity: 3, purchase_price: 1.5, source: "manabox" },
        { scryfall_id: "c2", finish: "foil", language: "de", binder: "", quantity: 1, purchase_price: null, source: "manabox" },
      ]);
      // Same key with another source is a separate row now.
      db.prepare("INSERT INTO collection (scryfall_id, finish, language, binder, quantity, source) VALUES ('c1', 'normal', 'en', 'Trade', 1, 'scan')").run();
      assert.throws(() => db.prepare("INSERT INTO collection (scryfall_id, finish, language, binder, quantity, source) VALUES ('c1', 'normal', 'en', 'Trade', 1, 'scan')").run(), /UNIQUE/);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scans'").get());
      assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      db.close();
      // Re-opening is a no-op.
      const again = openDb(file);
      assert.equal(again.prepare("SELECT COUNT(*) n FROM collection").get().n, 3);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staging", () => {
  test("stageScan stores the scan, its image and the detection features", () => {
    const { scan, duplicate } = stage(result(BOLT_DE, { store: BOLT }), { image: JPEG });
    assert.equal(duplicate, false);
    assert.equal(scan.status, "staged");
    assert.equal(scan.match_status, "auto");
    assert.equal(scan.printing_id, BOLT_DE.id);
    assert.equal(scan.store_printing_id, BOLT.id);
    assert.equal(scan.lang_detected, "de");
    assert.equal(scan.store_lang, "en");
    assert.equal(scan.quantity, 1);
    assert.equal(scan.condition, "near_mint");
    assert.equal(scan.has_image, true);
    assert.ok(existsSync(scanImagePath(ctx.db, scan.id, { imageDir })));
    assert.equal(scan.features, undefined, "features only on request");
    const full = getScan(ctx.db, scan.id, { features: true });
    assert.equal(full.features.result.status, "auto");
    assert.equal(full.features.collector.raw, "x");
  });

  test("failed results are not staged", () => {
    assert.deepEqual(stage({ status: "failed", printing: null }), { scan: null, duplicate: false });
    assert.equal(listScans(ctx.db).length, 0);
  });

  test("duplicate rule: same printing + finish right after itself is not staged", () => {
    const t = Date.parse("2026-10-13T10:00:00Z");
    const first = stage(result(BOLT), { now: t }).scan;
    const again = stage(result(BOLT), { now: t + 5000 });
    assert.equal(again.duplicate, true);
    assert.equal(again.scan.id, first.id);
    assert.equal(listScans(ctx.db).length, 1);
    // force, another finish, after the window, or another card: staged.
    assert.equal(stage(result(BOLT), { now: t + 6000, force: true }).duplicate, false);
    assert.equal(stage(result(BOLT, { finish: "foil" }), { now: t + 7000 }).duplicate, false);
    assert.equal(stage(result(SOL), { now: t + 8000 }).duplicate, false);
    assert.equal(stage(result(SOL), { now: t + 8000 + 21000 }).duplicate, false);
    assert.equal(listScans(ctx.db).length, 5);
  });

  test("review results are staged as review and skip the duplicate rule", () => {
    const t = Date.now();
    stage(result(BOLT), { now: t });
    const r = stage(result(BOLT, { status: "review" }), { now: t + 1000 });
    assert.equal(r.duplicate, false);
    assert.equal(r.scan.match_status, "review");
    // The same REVIEW detection right after itself (a re-capture) is a duplicate ...
    const again = stage(result(BOLT, { status: "review" }), { now: t + 2000 });
    assert.equal(again.duplicate, true);
    assert.equal(again.scan.id, r.scan.id);
    // ... and "Rescan" replaces the open review row instead of adding one.
    const re = stage(result(SOL, { status: "review" }), { now: t + 3000, replaceId: r.scan.id });
    assert.equal(re.duplicate, false);
    const reviews = listScans(ctx.db).filter((x) => x.match_status === "review");
    assert.deepEqual(reviews.map((x) => x.name), ["Sol Ring"], "the old review row is gone");
  });

  test("failed results are staged only in calibration mode, as uncommittable rows", async () => {
    const f = stage({ status: "failed", printing: null, features: { collector: { raw: "?" } } }, { calibration: true, image: JPEG, strip: JPEG });
    assert.equal(f.scan.match_status, "failed");
    assert.equal(f.scan.printing_id, null);
    assert.ok(existsSync(scanStripPath(ctx.db, f.scan.id, { imageDir })));
    await assert.rejects(commit([f.scan.id], { type: "binder", name: "X", create: true }), (e) => e.status === 409);
    recordTruth(ctx.db, f.scan.id, { printing_id: BOLT.id, finish: "normal" }, { idx, index });
    const row = exportCalibration(ctx.db).find((x) => x.id === f.scan.id);
    assert.equal(row.correct_printing, false, "a failed detection is not a correct one");
    assert.equal(row.detected.status, "failed");
    assert.ok(row.features.collector);
    assert.equal(getScan(ctx.db, f.scan.id).match_status, "confirmed");
  });

  test("increment (+1) and undo: decrement first, then delete", () => {
    const t = Date.now();
    const a = stage(result(SOL), { now: t - 2000, image: JPEG }).scan;
    const b = stage(result(BOLT), { now: t - 1000, image: JPEG }).scan;
    assert.equal(incrementScan(ctx.db, a.id).quantity, 2);
    // a was touched last: undo takes the +1 back.
    let u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "decrement");
    assert.equal(u.scan.quantity, 1);
    // a is still the most recently touched scan: the next undo removes it.
    u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "delete");
    assert.equal(u.scan.id, a.id);
    assert.equal(existsSync(path.join(imageDir, `scan-${a.id}.jpg`)), false);
    u = undoLast(ctx.db, { imageDir });
    assert.equal(u.scan.id, b.id);
    assert.deepEqual(undoLast(ctx.db, { imageDir }), { undone: null, scan: null });
  });

  test("undo reverts an edit (quantity via '-') instead of deleting the scan", () => {
    const t = Date.now();
    const a = stage(result(SOL), { now: t - 3000 }).scan;
    stage(result(BOLT), { now: t - 2000 });
    incrementScan(ctx.db, a.id); // qty 2
    updateScan(ctx.db, a.id, { quantity: 1 }); // the '-' button
    let u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "revert");
    assert.equal(u.scan.id, a.id);
    assert.equal(u.scan.quantity, 2);
    // Back to the +1: the next undo takes that back.
    u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "decrement");
    assert.equal(u.scan.quantity, 1);
  });

  test("updateScan: printing/language re-derive the stored printing; validation", () => {
    const s = stage(result(BOLT)).scan;
    let u = updateScan(ctx.db, s.id, { store_lang: "de" }, { idx, index });
    assert.equal(u.store_printing_id, BOLT_DE.id);
    assert.equal(u.store_lang, "de");
    u = updateScan(ctx.db, s.id, { printing_id: SERRA.id, store_lang: "en" }, { idx, index });
    assert.equal(u.printing_id, SERRA.id);
    assert.equal(u.match_status, "confirmed");
    assert.equal(u.name, "Serra Angel");
    assert.throws(() => updateScan(ctx.db, s.id, { finish: "foil" }, { idx, index }), /no foil finish/);
    assert.equal(updateScan(ctx.db, s.id, { quantity: 4, condition: "played" }).quantity, 4);
    assert.throws(() => updateScan(ctx.db, s.id, { quantity: 0 }), ScanError);
    assert.throws(() => updateScan(ctx.db, s.id, { condition: "awful" }), ScanError);
    assert.throws(() => updateScan(ctx.db, s.id, { printing_id: "nope" }, { idx, index }), /Unknown printing/);
    assert.throws(() => updateScan(ctx.db, 9999, {}), (e) => e.status === 404);
  });

  test("deleteScan removes the row and its image", () => {
    const s = stage(result(BOLT), { image: JPEG }).scan;
    deleteScan(ctx.db, s.id, { imageDir });
    assert.equal(getScan(ctx.db, s.id), null);
    assert.equal(existsSync(path.join(imageDir, `scan-${s.id}.jpg`)), false);
  });
});

describe("collector-line strip", () => {
  test("is stored for every staged scan (picker zoom), served by path, removed on delete and on commit", async () => {
    const t = Date.now();
    const a = stage(result(BOLT, { status: "review" }), { now: t - 3000, image: JPEG, strip: JPEG }).scan;
    assert.equal(a.has_strip, true);
    assert.equal(a.strip_path, undefined, "the file name stays internal");
    const file = scanStripPath(ctx.db, a.id, { imageDir });
    assert.ok(file && existsSync(file));
    const b = stage(result(SOL), { now: t - 2000, image: JPEG }).scan;
    assert.equal(b.has_strip, false);
    assert.equal(scanStripPath(ctx.db, b.id, { imageDir }), null);
    assert.equal(scanStripPath(ctx.db, 9999, { imageDir }), null);
    deleteScan(ctx.db, a.id, { imageDir });
    assert.ok(!existsSync(file));

    const c = stage(result(SERRA), { now: t - 1000, image: JPEG, strip: JPEG }).scan;
    const cFile = scanStripPath(ctx.db, c.id, { imageDir });
    await commit([c.id], { type: "binder", name: "S", create: true });
    assert.ok(!existsSync(cFile));
    assert.equal(getScan(ctx.db, c.id).has_strip, false);
  });

  test("a reused scan id (undo, then a new scan) comes with a new created_at for the UI's cache-busting URL", () => {
    const t = Date.now();
    const a = stage(result(BOLT, { status: "review" }), { now: t - 3000, image: JPEG, strip: JPEG }).scan;
    undoLast(ctx.db, { imageDir });
    const b = stage(result(SOL, { status: "review" }), { now: t - 1000, image: JPEG, strip: JPEG }).scan;
    assert.equal(b.id, a.id, "SQLite reuses the newest deleted rowid");
    assert.notEqual(b.created_at, a.created_at);
  });
});

describe("commit", () => {
  test("to a new binder: collection rows with source 'scan'; Scryfall only for unknown cards", async () => {
    ctx.db.prepare("DELETE FROM cards WHERE scryfall_id = ?").run(ID.serra);
    const t = Date.now();
    const a = stage(result(BOLT), { now: t - 3000, image: JPEG }).scan;
    const b = stage(result(SERRA), { now: t - 2000 }).scan;
    incrementScan(ctx.db, b.id);
    await assert.rejects(commit([a.id], { type: "binder", name: "Scans 1" }), (e) => e.status === 404);
    const res = await commit([a.id, b.id], { type: "binder", name: "Scans 1", create: true });
    assert.deepEqual(res, { committed: 2, copies: 3, target: { type: "binder", name: "Scans 1", created: true } });
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0], [{ id: ID.serra }]);
    const rows = ctx.db.prepare("SELECT scryfall_id, quantity, binder, source, language FROM collection ORDER BY scryfall_id").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { scryfall_id: ID.lightning, quantity: 1, binder: "Scans 1", source: "scan", language: "en" },
      { scryfall_id: ID.serra, quantity: 2, binder: "Scans 1", source: "scan", language: "en" },
    ]);
    assert.equal(listScans(ctx.db).length, 0);
    const done = listScans(ctx.db, { status: "committed" });
    assert.equal(done.length, 2);
    assert.deepEqual(done[0].committed_to, { type: "binder", name: "Scans 1" });
    assert.equal(existsSync(path.join(imageDir, `scan-${a.id}.jpg`)), false, "image dropped after commit");
    // Into the now existing binder: quantities merge.
    const c = stage(result(BOLT), { force: true }).scan;
    await commit([c.id], { type: "binder", name: "Scans 1" });
    assert.equal(ctx.db.prepare("SELECT quantity FROM collection WHERE scryfall_id = ? AND binder = 'Scans 1'").get(ID.lightning).quantity, 2);
  });

  test("refuses review scans, committed scans and bad targets", async () => {
    const r = stage(result(BOLT, { status: "review" })).scan;
    await assert.rejects(commit([r.id], { type: "binder", name: "X", create: true }), /needs review/);
    updateScan(ctx.db, r.id, { printing_id: BOLT.id }, { idx, index });
    await commit([r.id], { type: "binder", name: "X", create: true });
    await assert.rejects(commit([r.id], { type: "binder", name: "X" }), /already committed/);
    const s = stage(result(SOL)).scan;
    await assert.rejects(commit([s.id], { type: "shelf" }), /target.type/);
    await assert.rejects(commit([s.id], { type: "deck", name: "Nope" }), (e) => e.status === 404);
    await assert.rejects(commit([s.id], { type: "deck", name: "D", create: true, board: "graveyard" }), /board/);
    await assert.rejects(commit([], { type: "binder", name: "X" }), /non-empty/);
  });

  test("to a new deck (format, board) and appending to an existing deck by id", async () => {
    const t = Date.now();
    const a = stage(result(SOL), { now: t - 2000 }).scan;
    const b = stage(result(BOLT, { finish: "foil" }), { now: t - 1000 }).scan;
    const res = await commit([a.id, b.id], { type: "deck", name: "Scanned Deck", create: true, format: "commander", board: "main" });
    assert.equal(res.target.type, "deck");
    assert.equal(res.target.created, true);
    const deck = deckDetail(ctx.db, res.target.id);
    assert.equal(deck.name, "Scanned Deck");
    assert.equal(deck.format, "commander");
    assert.equal(deck.source, "scan");
    assert.equal(deck.counts.main, 2);
    // The copies are owned too, in a binder named after the deck.
    const owned = ctx.db.prepare("SELECT scryfall_id, finish, binder, source FROM collection ORDER BY scryfall_id").all();
    assert.deepEqual(owned.map((r) => ({ ...r })), [
      { scryfall_id: ID.sol, finish: "normal", binder: "Scanned Deck", source: "scan" },
      { scryfall_id: ID.lightning, finish: "foil", binder: "Scanned Deck", source: "scan" },
    ].sort((x, y) => x.scryfall_id.localeCompare(y.scryfall_id)));
    const c = stage(result(SOL), { force: true }).scan;
    const res2 = await commit([c.id], { type: "deck", id: res.target.id, board: "side" });
    assert.equal(res2.target.id, res.target.id);
    const deck2 = deckDetail(ctx.db, res.target.id);
    assert.equal(deck2.counts.main, 2);
    assert.equal(deck2.counts.side, 1);
    // Existing deck by name, without owning the copies.
    const d = stage(result(SERRA)).scan;
    await commit([d.id], { type: "deck", name: "scanned deck", board: "maybe", owned: false });
    assert.equal(deckDetail(ctx.db, res.target.id).counts.maybe, 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM collection WHERE scryfall_id = ?").get(ID.serra).n, 0);
  });

  test("offline: card data falls back to the local index", async () => {
    const s = stage(result(BOLT_DE)).scan;
    const res = await commit([s.id], { type: "binder", name: "DE", create: true }, { fetchCards: async () => { throw new TypeError("fetch failed"); } });
    assert.equal(res.committed, 1);
    const card = ctx.db.prepare("SELECT name, lang, set_code FROM cards WHERE scryfall_id = ?").get(BOLT_DE.id);
    assert.deepEqual({ ...card }, { name: "Lightning Bolt", lang: "de", set_code: "m10" });
    assert.equal(ctx.db.prepare("SELECT language FROM collection WHERE scryfall_id = ?").get(BOLT_DE.id).language, "de");
    // Marked as a fallback (colours from the mana cost) and replaced at the next successful commit.
    const fb = ctx.db.prepare("SELECT colors, fetched_at FROM cards WHERE scryfall_id = ?").get(BOLT_DE.id);
    assert.deepEqual({ ...fb }, { colors: "R", fetched_at: "" });
    const s2 = stage(result(SOL)).scan;
    const asked = [];
    await commit([s2.id], { type: "binder", name: "DE" }, {
      fetchCards: async (ids) => { asked.push(...ids); return { cards: [{ ...fx(ID.lightning), id: BOLT_DE.id, lang: "de" }, fx(ID.sol)].filter((c) => ids.includes(c.id)) }; },
    });
    assert.ok(asked.includes(BOLT_DE.id), "the fallback row is re-fetched");
    assert.notEqual(ctx.db.prepare("SELECT fetched_at FROM cards WHERE scryfall_id = ?").get(BOLT_DE.id).fetched_at, "");
  });

  test("decks synced from ManaBox are not a commit target", async () => {
    ctx.db.prepare("INSERT INTO decks (name, source) VALUES ('Elves', 'manabox')").run();
    const s = stage(result(SOL)).scan;
    await assert.rejects(commit([s.id], { type: "deck", name: "Elves", board: "main" }), (e) => e.status === 409 && /ManaBox/.test(e.message));
  });
});

describe("binders and ManaBox replace", () => {
  test("listBinders / renameBinder (merge) / deleteBinder (scan rows only)", async () => {
    seedCollection(ctx.db, [[ID.sol, 2, { binder: "Trade" }], [ID.lightning, 1]]);
    const s = stage(result(SOL)).scan;
    await commit([s.id], { type: "binder", name: "Trade" });
    const s2 = stage(result(BOLT), { force: true }).scan;
    await commit([s2.id], { type: "binder", name: "Box", create: true });
    const flat = () => { const l = listBinders(ctx.db); return [...l.binders, { ...l.unsorted, name: "" }]; };
    let binders = flat();
    assert.deepEqual(binders.map((b) => [b.name, b.copies, b.sources.join("+")]), [["Box", 1, "scan"], ["Trade", 3, "manabox+scan"], ["", 1, "manabox"]]);
    renameBinder(ctx.db, "Box", "Trade");
    binders = flat();
    assert.deepEqual(binders.map((b) => [b.name, b.copies]), [["Trade", 4], ["", 1]]);
    assert.throws(() => renameBinder(ctx.db, "Nope", "X"), (e) => e.status === 404);
    assert.throws(() => renameBinder(ctx.db, "Trade", "Tausch"), (e) => e.status === 409 && e.extra?.code === "confirm_master",
      "moving ManaBox rows needs the one-time master confirmation");
    assert.equal(deleteBinder(ctx.db, "Trade", { source: "scan" }).deleted, 2);
    assert.deepEqual(flat().map((b) => [b.name, b.copies, b.sources.join("+")]), [["Trade", 2, "manabox"], ["", 1, "manabox"]]);
  });

  test("a ManaBox replace import leaves scanned rows alone", async () => {
    seedCollection(ctx.db, [[ID.atraxa, 1, { binder: "Old" }]]);
    const s = stage(result(SOL)).scan;
    await commit([s.id], { type: "binder", name: "Scans", create: true });
    const csv = `Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Language,Binder Name\nLightning Bolt,m10,146,normal,3,${ID.lightning},en,Trade\n`;
    await importManaBoxCsv(ctx.db, csv, { mode: "replace" });
    const rows = ctx.db.prepare("SELECT scryfall_id, binder, quantity, source FROM collection ORDER BY source, scryfall_id").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { scryfall_id: ID.lightning, binder: "Trade", quantity: 3, source: "manabox" },
      { scryfall_id: ID.sol, binder: "Scans", quantity: 1, source: "scan" },
    ]);
    // add mode merges into ManaBox rows, never into scanned ones.
    await importManaBoxCsv(ctx.db, csv.replace("Trade", "Scans"), { mode: "add" });
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM collection WHERE binder = 'Scans'").get().n, 2);
  });
});

describe("scan image names", () => {
  test("a reused scan id never overwrites or deletes an older scan's photo", async () => {
    const a = stage(result(BOLT), { image: JPEG, strip: JPEG, calibration: true }).scan;
    const oldImage = scanImagePath(ctx.db, a.id, { imageDir });
    const oldStrip = scanStripPath(ctx.db, a.id, { imageDir });
    assert.match(path.basename(oldImage), /^scan-\d+-[0-9a-f]{12}\.jpg$/);
    assert.match(path.basename(oldStrip), /^scan-\d+-[0-9a-f]{12}-strip\.jpg$/);
    // As after restoring an older backup: the row is gone, its files stay on disk.
    ctx.db.prepare("DELETE FROM scans WHERE id = ?").run(a.id);
    const b = stage(result(SOL), { image: JPEG, strip: JPEG }).scan;
    assert.equal(b.id, a.id, "SQLite hands out the same id again");
    assert.notEqual(scanImagePath(ctx.db, b.id, { imageDir }), oldImage);
    await commit([b.id], { type: "binder", name: "X", create: true });
    assert.ok(existsSync(oldImage) && existsSync(oldStrip), "committing the new scan leaves the old photos alone");
  });
});

describe("calibration", () => {
  test("recordTruth corrects a staged scan; export lists truth vs detection; images kept on commit", async () => {
    const s = stage(result(BOLT), { image: JPEG, strip: JPEG, calibration: true }).scan;
    assert.equal(s.calibration, true);
    assert.ok(existsSync(scanStripPath(ctx.db, s.id, { imageDir })));
    const u = recordTruth(ctx.db, s.id, { printing_id: SOL.id, finish: "foil" }, { idx, index });
    assert.equal(u.printing_id, SOL.id);
    assert.equal(u.finish, "foil");
    assert.equal(u.calibration_truth.set_code, "c21");
    const ok = stage(result(SERRA)).scan;
    recordTruth(ctx.db, ok.id, { printing_id: SERRA.id }, { idx, index });
    const rows = exportCalibration(ctx.db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].correct_printing, false);
    assert.equal(rows[0].correct_finish, false);
    assert.equal(rows[0].detected.printing_id, BOLT.id);
    assert.equal(rows[1].correct_printing, true);
    assert.ok(rows[0].features.collector);
    await commit([s.id, ok.id], { type: "binder", name: "Cal", create: true });
    assert.ok(existsSync(scanImagePath(ctx.db, s.id, { imageDir })), "calibration images survive the commit");
    assert.throws(() => recordTruth(ctx.db, s.id, {}, { idx, index }), /printing_id/);
  });
});
