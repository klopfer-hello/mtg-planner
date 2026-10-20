// Deck history (lib/deckhistory.js, migration v10): versions per deck change,
// dedupe, pruning, diffs, restore, the writers that record (app, claude, import,
// scan) and the v9 -> v10 upgrade with one baseline version per existing deck.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openDb } from "../lib/db.js";
import { parseDecklist } from "../lib/deckrules.js";
import { saveDeck } from "../lib/decks.js";
import { setCommander, setDeckStatus, updateDeckCard } from "../lib/deckedit.js";
import {
  DECK_VERSIONS_KEEP, deckVersion, diffSnapshots, diffSummary, listDeckVersions, recordDeckVersion, restoreDeckVersion, snapshotDeck,
} from "../lib/deckhistory.js";
import { importManaBoxCsv } from "../lib/manabox.js";
import { ID, seedCards, stubScryfall, tempDb } from "./fixtures.js";
import { manaboxCsv, manaboxLine } from "./helpers/csv.js";

const items = (text) => parseDecklist(text).items;
const versions = (db, id) => listDeckVersions(db, id).versions;

describe("deck history", () => {
  let ctx, stub;
  beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); stub = stubScryfall(); });
  afterEach(() => { stub.restore(); ctx.cleanup(); });

  test("schema v10 has the history and build tables", () => {
    assert.ok(SCHEMA_VERSION >= 10);
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes("deck_versions"));
    assert.ok(tables.includes("deck_build_picks"));
  });

  test("saveDeck records 'Created', each change a diff summary, identical states once", async () => {
    const { id } = await saveDeck(ctx.db, { name: "Angels", source: "manual", items: items("1 Sol Ring\n2 Lightning Bolt\n1 Serra Angel") });
    let v = versions(ctx.db, id);
    assert.equal(v.length, 1);
    assert.deepEqual([v[0].actor, v[0].summary, v[0].card_count, v[0].current], ["app", "Created · 4 cards", 4, true]);

    updateDeckCard(ctx.db, id, { name: "Lightning Bolt", board: "main", quantity: 3 });
    updateDeckCard(ctx.db, id, { name: "Serra Angel", board: "main", quantity: 0 });
    v = versions(ctx.db, id);
    assert.deepEqual(v.map((x) => x.summary), ["−1 card", "+1 card", "Created · 4 cards"]);
    assert.deepEqual(v.map((x) => x.current), [true, false, false]);

    // Setting the same status again changes nothing: no new version.
    setDeckStatus(ctx.db, id, "idea");
    assert.equal(versions(ctx.db, id).length, 3);
    setDeckStatus(ctx.db, id, "built");
    assert.equal(versions(ctx.db, id)[0].summary, "status built");
  });

  test("Claude's save_deck path records actor claude; a board move counts as moved", async () => {
    const { id } = await saveDeck(ctx.db, { name: "Atraxa", format: "commander", source: "claude", items: items("1 Atraxa, Praetors' Voice\n1 Sol Ring") });
    assert.equal(versions(ctx.db, id)[0].actor, "claude");
    setCommander(ctx.db, id, { name: "Atraxa, Praetors' Voice" });
    const [top] = versions(ctx.db, id);
    assert.equal(top.summary, "1 moved");
    const d = deckVersion(ctx.db, id, top.id).diff;
    assert.deepEqual(d.boards.map((b) => [b.board, b.added.length, b.removed.length]), [["commander", 1, 0], ["main", 0, 1]]);
  });

  test("restore puts rows, name and bracket back, keeps the status, adds a version", async () => {
    const { id } = await saveDeck(ctx.db, { name: "Burn", source: "manual", items: items("4 Lightning Bolt\n1 Sol Ring") });
    const first = versions(ctx.db, id)[0].id;
    updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", quantity: 0 });
    ctx.db.prepare("UPDATE decks SET name = 'Burn 2', bracket_declared = 3, status = 'built' WHERE id = ?").run(id);
    recordDeckVersion(ctx.db, id, { actor: "app" });

    const preview = deckVersion(ctx.db, id, first);
    assert.equal(preview.diff, null, "oldest version has nothing to compare with");
    assert.match(preview.restore.summary, /\+1 card/);
    assert.ok(!preview.restore.meta.some((m) => m.field === "status"), "a restore keeps the status");

    const r = restoreDeckVersion(ctx.db, id, first);
    assert.equal(r.restored_from, first);
    const deck = ctx.db.prepare("SELECT * FROM decks WHERE id = ?").get(id);
    assert.deepEqual([deck.name, deck.bracket_declared, deck.status], ["Burn", null, "built"]);
    assert.deepEqual(snapshotDeck(ctx.db, id).cards.map((c) => `${c.quantity} ${c.name}`), ["4 Lightning Bolt", "1 Sol Ring"]);
    const v = versions(ctx.db, id);
    assert.equal(v.length, 4);
    assert.match(v[0].summary, /^Restored version from /);
    assert.equal(v[0].restored_from, first);
    // Restoring the state the deck already has changes nothing.
    assert.equal(restoreDeckVersion(ctx.db, id, v[0].id).version_id, null);
    assert.throws(() => restoreDeckVersion(ctx.db, id, 999999), (e) => e.status === 404);
  });

  test("keeps the newest DECK_VERSIONS_KEEP versions; deleting the deck deletes its history", async () => {
    const { id } = await saveDeck(ctx.db, { name: "Many", source: "manual", items: items("1 Sol Ring") });
    for (let i = 2; i <= DECK_VERSIONS_KEEP + 5; i++) updateDeckCard(ctx.db, id, { name: "Sol Ring", board: "main", quantity: i });
    const v = versions(ctx.db, id);
    assert.equal(v.length, DECK_VERSIONS_KEEP);
    assert.equal(v[0].card_count, DECK_VERSIONS_KEEP + 5);
    ctx.db.prepare("DELETE FROM decks WHERE id = ?").run(id);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM deck_versions").get().n, 0);
  });

  test("ManaBox imports record actor import (once per real change)", async () => {
    const row = (name, set, num, qty, sid) => manaboxLine("My Deck", name, set, num, qty, sid, { type: "deck" });
    const csv = manaboxCsv;
    await importManaBoxCsv(ctx.db, csv(row("Sol Ring", "c21", "263", "1", ID.sol)));
    const id = ctx.db.prepare("SELECT id FROM decks WHERE source = 'manabox'").get().id;
    await importManaBoxCsv(ctx.db, csv(row("Sol Ring", "c21", "263", "1", ID.sol)), { mode: "replace" });
    await importManaBoxCsv(ctx.db, csv(row("Sol Ring", "c21", "263", "1", ID.sol), row("Lightning Bolt", "m10", "146", "2", ID.lightning)), { mode: "replace" });
    const v = versions(ctx.db, id);
    assert.deepEqual(v.map((x) => [x.actor, x.summary]), [["import", "+2 cards"], ["import", "Created · 1 card"]]);
  });

  test("diffSummary names meta changes and printing swaps", () => {
    const a = { meta: { name: "A", format: null, description: null, status: "idea", bracket_declared: null }, cards: [{ board: "main", name: "Sol Ring", quantity: 1, scryfall_id: "x", companion: 0 }] };
    const b = { meta: { ...a.meta, name: "B", format: "commander", bracket_declared: 2 }, cards: [{ board: "main", name: "Sol Ring", quantity: 1, scryfall_id: "y", companion: 0 }] };
    assert.equal(diffSummary(diffSnapshots(a, b)), '1 printing changed · renamed to "B" · format commander · bracket 2');
  });
});

describe("migration v10", () => {
  test("upgrading a v9 database adds the tables and one baseline version per deck, data untouched", () => {
    const ctx = tempDb();
    try {
      seedCards(ctx.db);
      ctx.db.prepare("INSERT INTO decks (id, name, format, status, updated_at) VALUES (1, 'Old', 'commander', 'built', '2026-10-01 12:30:00')").run();
      ctx.db.prepare("INSERT INTO decks (id, name) VALUES (2, 'Empty')").run();
      ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'commander', 'Atraxa, Praetors'' Voice', ?, 1)").run(ID.atraxa);
      ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Sol Ring', ?, 1)").run(ID.sol);
      ctx.db.exec("DROP TABLE deck_versions; DROP TABLE deck_build_picks; PRAGMA user_version = 9");
      ctx.db.close();
      const raw = new DatabaseSync(ctx.file);
      assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 9);
      raw.close();

      const db = openDb(ctx.file);
      try {
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
        const v = db.prepare("SELECT deck_id, actor, summary, at, card_count FROM deck_versions ORDER BY deck_id").all();
        assert.deepEqual(v.map((x) => ({ ...x })), [
          { deck_id: 1, actor: "system", summary: "Saved before the history started", at: "2026-10-01T12:30:00.000Z", card_count: 2 },
          { deck_id: 2, actor: "system", summary: "Saved before the history started", at: v[1].at, card_count: 0 },
        ]);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deck_cards").get().n, 2);
        assert.equal(listDeckVersions(db, 1).versions[0].current, true);
        // Running the migrations again changes nothing.
        db.exec("PRAGMA user_version = 9");
      } finally { db.close(); }
      const again = openDb(ctx.file);
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM deck_versions").get().n, 2);
      again.close();
    } finally { ctx.cleanup(); }
  });
});
