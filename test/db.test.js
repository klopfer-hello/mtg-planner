// Schema v9 (deck insights data): migration v8 -> v9 with data (idempotent),
// normalizeCard's new card facts and nullable cmc (recorded Scryfall cards),
// the COALESCE upsert, the card-facts backfill gate, NULL cmc in search
// filters/sort, the index fact columns, the offline card row from the index,
// and companions in decklists. Offline: Scryfall is stubbed.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, getAppMeta, openDb, upsertCards } from "../lib/db.js";
import { normalizeCard } from "../lib/scryfall.js";
import { CARD_FACTS_META, backfillCardFacts, cardFactsPending } from "../lib/manabox.js";
import { searchCollection } from "../lib/query.js";
import { deckDetail, exportDeck, parseDecklist, saveDeck } from "../lib/decks.js";
import { editCopies } from "../lib/edits.js";
import { getPrinting, openIndex, refreshIndex } from "../lib/cardindex.js";
import { ID, SCRYFALL_CARDS, seedCards, seedCollection, stubScryfall, tempDb } from "./fixtures.js";

const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/scryfall-v9-cards.json", import.meta.url), "utf8")).cards;
const rec = (name) => RECORDED.find((c) => c.name.startsWith(name));

let ctx;
beforeEach(() => { ctx = tempDb(); seedCards(ctx.db); });
afterEach(() => ctx.cleanup());

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

describe("normalizeCard (v9 facts)", () => {
  test("reversible_card takes cmc, type, cost, colours and text from the front face", () => {
    const r = normalizeCard(rec("Sol Ring"));
    assert.equal(r.layout, "reversible_card");
    assert.equal(r.cmc, 1);
    assert.equal(r.type_line, "Artifact");
    assert.equal(r.mana_cost, "{1}");
    assert.equal(r.oracle_text, "{T}: Add {C}{C}.");
    assert.equal(r.colors, "");
    assert.equal(r.game_changer, 0);
    assert.equal(r.produced_mana, '["C"]');
    assert.equal(r.oracle_id, rec("Sol Ring").card_faces[0].oracle_id);
  });

  test("game_changer 0/1, produced_mana JSON, layout; MDFC keeps the joined faces", () => {
    const tergrid = normalizeCard(rec("Tergrid"));
    assert.equal(tergrid.game_changer, 1);
    assert.equal(tergrid.layout, "modal_dfc");
    assert.equal(tergrid.produced_mana, null);
    assert.equal(tergrid.cmc, 5);
    const emeria = normalizeCard(rec("Emeria's Call"));
    assert.equal(emeria.produced_mana, '["W"]');
    assert.match(emeria.type_line, / \/\/ Land/);
    assert.deepEqual(JSON.parse(normalizeCard(rec("Command Tower")).produced_mana).sort(), ["B", "G", "R", "U", "W"]);
    assert.equal(normalizeCard(rec("Bonecrusher")).layout, "adventure");
  });

  test("missing flag -> NULL (unknown); missing cmc -> front face cmc, else NULL (never 0)", () => {
    const base = SCRYFALL_CARDS[0];
    assert.equal(normalizeCard(base).game_changer, null);
    const { cmc, ...noCmc } = base;
    assert.equal(cmc, 1);
    assert.equal(normalizeCard(noCmc).cmc, null);
    assert.equal(normalizeCard({ ...noCmc, card_faces: [{ name: "A", cmc: 3 }, { name: "B", cmc: 1 }] }).cmc, 3);
    assert.equal(normalizeCard({ ...base, cmc: 0 }).cmc, 0, "a real 0 stays 0");
    // produced_mana falls back to the union over the faces
    assert.equal(normalizeCard({ ...base, produced_mana: undefined, card_faces: [{ produced_mana: ["G"] }, { produced_mana: ["G", "U"] }] }).produced_mana, '["G","U"]');
  });
});

describe("migrations v10-v14", () => {
  test("v9 -> v14: deck history/build picks, wishlist, value history and binder type/cover; rows kept, idempotent re-run", () => {
    seedCollection(ctx.db, [[ID.sol, 2, { binder: "Box" }], [ID.lightning, 1]]);
    ctx.db.prepare("INSERT INTO decks (name, format, source, status) VALUES ('D', 'commander', 'manual', 'built'), ('E', NULL, 'manual', 'idea')").run();
    ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Sol Ring', ?, 1)").run(ID.sol);
    ctx.db.exec(`DROP TABLE deck_build_picks; DROP TABLE deck_versions; DROP TABLE wishlist; DROP TABLE value_history; DROP TABLE value_history_binders; DROP TABLE card_history;
      ALTER TABLE binders DROP COLUMN type; ALTER TABLE binders DROP COLUMN cover_scryfall_id; PRAGMA user_version = 9`);
    ctx.db.close();
    assert.equal(SCHEMA_VERSION, 18);
    for (let i = 0; i < 2; i++) {
      const db = openDb(ctx.file);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      for (const t of ["wishlist", "value_history", "value_history_binders", "card_history"]) assert.ok(cols(db, t).length > 0, t);
      for (const c of ["type", "cover_scryfall_id"]) assert.ok(cols(db, "binders").includes(c), c);
      for (const t of ["deck_versions", "deck_build_picks"]) assert.ok(cols(db, t).length > 0, t);
      assert.deepEqual(db.prepare("SELECT deck_id, COUNT(*) AS n FROM deck_versions GROUP BY deck_id ORDER BY deck_id").all().map((r) => [r.deck_id, r.n]), [[1, 1], [2, 1]], "one starting version per deck");
      assert.equal(db.prepare("SELECT card_count FROM deck_versions WHERE deck_id = 1").get().card_count, 1);
      assert.equal(db.prepare("SELECT SUM(quantity) AS n FROM collection").get().n, 3);
      if (i === 0) db.prepare("INSERT INTO binders (name, origin, type) VALUES ('Box', 'app', 'trade') ON CONFLICT(name) DO UPDATE SET type = 'trade'").run();
      db.exec("PRAGMA user_version = 9"); // re-run v10-v14 on a migrated DB
      db.close();
    }
    const db = openDb(ctx.file);
    assert.equal(db.prepare("SELECT type FROM binders WHERE name = 'Box'").get().type, "trade", "kept on re-run");
    db.close(); // every connection is closed: the temp dir can be removed (also on Windows)
  });
});

describe("migration v9", () => {
  test("v8 -> v9 keeps every row, new facts are NULL, idempotent re-run", () => {
    seedCollection(ctx.db, [[ID.sol, 2, { binder: "Box" }], [ID.lightning, 1]]);
    ctx.db.prepare("INSERT INTO decks (name, format, source, status) VALUES ('D', 'commander', 'manual', 'built')").run();
    ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Sol Ring', ?, 1), (1, 'main', 'Typo Card', NULL, 1)").run(ID.sol);
    // Downgrade to the v8 schema.
    ctx.db.exec(`ALTER TABLE cards DROP COLUMN game_changer; ALTER TABLE cards DROP COLUMN produced_mana; ALTER TABLE cards DROP COLUMN layout;
      ALTER TABLE decks DROP COLUMN bracket_declared; ALTER TABLE deck_cards DROP COLUMN companion; DROP TABLE spellbook_cache;
      PRAGMA user_version = 8`);
    ctx.db.close();
    const raw = new DatabaseSync(ctx.file);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 8);
    assert.ok(!cols(raw, "cards").includes("game_changer"));
    const before = raw.prepare("SELECT COUNT(*) AS n FROM cards").get().n;
    raw.close();

    for (let i = 0; i < 2; i++) {
      const db = openDb(ctx.file);
      assert.ok(SCHEMA_VERSION >= 9);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      for (const c of ["game_changer", "produced_mana", "layout"]) assert.ok(cols(db, "cards").includes(c), c);
      assert.ok(cols(db, "decks").includes("bracket_declared"));
      assert.ok(cols(db, "deck_cards").includes("companion"));
      assert.deepEqual(cols(db, "spellbook_cache"), ["key", "fetched_at", "last_used_at", "status", "error", "tag_raw", "parser", "result"]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards").get().n, before);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards WHERE game_changer IS NOT NULL OR produced_mana IS NOT NULL OR layout IS NOT NULL").get().n, 0);
      assert.equal(db.prepare("SELECT SUM(quantity) AS n FROM collection").get().n, 3);
      assert.deepEqual(db.prepare("SELECT name, companion FROM deck_cards ORDER BY name").all().map((r) => [r.name, r.companion]), [["Sol Ring", 0], ["Typo Card", 0]]);
      if (i === 0) assert.equal(db.prepare("SELECT bracket_declared FROM decks").get().bracket_declared, null);
      // A restored v8 backup queues the backfill: its owned/deck cards are pending.
      assert.deepEqual(cardFactsPending(db), [ID.sol, ID.lightning].sort());
      db.prepare("UPDATE decks SET bracket_declared = 3").run();
      db.prepare("INSERT OR REPLACE INTO spellbook_cache (key, status) VALUES ('k', 'ok')").run();
      db.exec("PRAGMA user_version = 8"); // re-run the migration on a migrated DB
      db.close();
    }
    const db = openDb(ctx.file);
    assert.equal(db.prepare("SELECT bracket_declared FROM decks").get().bracket_declared, 3, "kept on re-run");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache").get().n, 1);
    db.close(); // every connection is closed: the temp dir can be removed (also on Windows)
  });
});

describe("upsertCards COALESCE", () => {
  test("a NULL fact (offline fallback row) never wipes a known one; cmc is a plain overwrite", () => {
    upsertCards(ctx.db, [normalizeCard(rec("Tergrid"))]);
    const id = rec("Tergrid").id;
    upsertCards(ctx.db, [{ scryfall_id: id, oracle_id: "x", name: "Tergrid, God of Fright // Tergrid's Lantern", cmc: null, colors: "", color_identity: "", fetched_at: "",
      game_changer: null, produced_mana: null, layout: null }]);
    const r = ctx.db.prepare("SELECT * FROM cards WHERE scryfall_id = ?").get(id);
    assert.equal(r.game_changer, 1);
    assert.equal(r.layout, "modal_dfc");
    assert.equal(r.cmc, null, "cmc overwritten");
    assert.equal(r.fetched_at, "");
    // A known value does replace: WotC can drop a card from the list.
    upsertCards(ctx.db, [{ ...normalizeCard(rec("Tergrid")), game_changer: 0 }]);
    assert.equal(ctx.db.prepare("SELECT game_changer FROM cards WHERE scryfall_id = ?").get(id).game_changer, 0);
  });
});

describe("card facts backfill", () => {
  const POOL = SCRYFALL_CARDS.map((c) => ({ ...c, game_changer: c.id === ID.sol ? false : c.id === ID.lightning ? true : undefined }));
  let stub;
  beforeEach(() => { stub = stubScryfall(POOL); });
  afterEach(() => stub.restore());

  test("fills owned + deck rows only, then the gate is closed (no further fetch)", async () => {
    seedCollection(ctx.db, [[ID.sol, 1], [ID.lightning, 1]]);
    ctx.db.prepare("INSERT INTO decks (name) VALUES ('D')").run();
    ctx.db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (1, 'main', 'Serra Angel', ?, 1), (1, 'main', 'Nope', NULL, 1)").run(ID.serra);
    // An offline fallback row (fetched_at '') is left for the next commit's re-fetch.
    ctx.db.prepare("UPDATE cards SET fetched_at = '' WHERE scryfall_id = ?").run(ID.lightning);
    assert.deepEqual(cardFactsPending(ctx.db), [ID.sol, ID.serra].sort());
    const r = await backfillCardFacts(ctx.db);
    assert.deepEqual(r, { pending: 2, refreshed: 2, skipped: 1 }, "Serra has no flag in the pool -> skipped");
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].map((i) => i.id).sort(), [ID.sol, ID.serra].sort());
    assert.equal(ctx.db.prepare("SELECT game_changer FROM cards WHERE scryfall_id = ?").get(ID.sol).game_changer, 0);
    assert.equal(ctx.db.prepare("SELECT game_changer FROM cards WHERE scryfall_id = ?").get(ID.atraxa).game_changer, null, "not owned, not in a deck");
    const meta = JSON.parse(getAppMeta(ctx.db, CARD_FACTS_META));
    assert.deepEqual(meta.skipped, [ID.serra]);
    assert.ok(meta.done_at);
    assert.deepEqual(cardFactsPending(ctx.db), []);
    assert.deepEqual(await backfillCardFacts(ctx.db), { pending: 0, refreshed: 0, skipped: 0 });
    assert.equal(stub.calls.length, 1, "no second fetch");
  });

  test("chunks run through runChunk; a busy chunk (409) aborts, finished chunks stay done, a retry resumes", async () => {
    seedCollection(ctx.db, [[ID.sol, 1], [ID.lightning, 1], [ID.counterspell, 1]]);
    let calls = 0;
    const busy = async (fn) => { if (++calls === 2) throw Object.assign(new Error("busy"), { status: 409 }); return fn(); };
    await assert.rejects(backfillCardFacts(() => ctx.db, { runChunk: busy, chunkSize: 1 }), /busy/);
    assert.equal(cardFactsPending(ctx.db).length, 2, "first chunk done");
    assert.equal(getAppMeta(ctx.db, CARD_FACTS_META), null);
    const r = await backfillCardFacts(() => ctx.db, { chunkSize: 1 });
    assert.equal(r.pending, 2);
    assert.deepEqual(cardFactsPending(ctx.db), []);
  });

  test("the Scryfall fetch runs outside runChunk (no lock held during network), with an abort signal", async () => {
    seedCollection(ctx.db, [[ID.sol, 1], [ID.lightning, 1], [ID.counterspell, 1]]);
    let locked = false;
    const seen = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init = {}) => { seen.push({ locked, signal: init.signal instanceof AbortSignal }); return inner(url, init); };
    try {
      const lock = (fn) => { locked = true; try { return fn(); } finally { locked = false; } };
      const r = await backfillCardFacts(() => ctx.db, { runChunk: lock, chunkSize: 1 });
      assert.equal(r.pending, 3);
    } finally { globalThis.fetch = inner; }
    assert.equal(seen.length, 3);
    assert.ok(seen.every((s) => !s.locked && s.signal), JSON.stringify(seen));
    assert.deepEqual(cardFactsPending(ctx.db), []);
  });

  test("an empty, never-run DB writes the gate once", async () => {
    assert.deepEqual(await backfillCardFacts(ctx.db), { pending: 0, refreshed: 0, skipped: 0 });
    assert.ok(getAppMeta(ctx.db, CARD_FACTS_META));
    assert.equal(stub.calls.length, 0);
  });
});

describe("search with NULL cmc", () => {
  test("no numeric filter matches an unknown mana value; it sorts last both ways", () => {
    seedCollection(ctx.db, [[ID.sol, 1], [ID.serra, 1], [ID.counterspell, 1]]);
    ctx.db.prepare("UPDATE cards SET cmc = NULL WHERE scryfall_id = ?").run(ID.counterspell);
    const names = (q, o = {}) => searchCollection(ctx.db, { q, ...o }).rows.map((r) => r.name);
    assert.deepEqual(names("cmc<=3"), ["Sol Ring"]);
    assert.deepEqual(names("-cmc<=3"), ["Serra Angel"]);
    assert.deepEqual(names("mv=0"), []);
    assert.deepEqual(names("cmc!=5"), ["Sol Ring"]);
    assert.deepEqual(names("", { sort: "cmc" }), ["Sol Ring", "Serra Angel", "Counterspell"]);
    assert.deepEqual(names("", { sort: "cmc", dir: "desc" }), ["Serra Angel", "Sol Ring", "Counterspell"]);
  });
});

describe("card index facts + offline card rows", () => {
  test("refreshIndex stores game_changer/produced_mana; an old index gets the columns; edits' fallback row carries them", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-v9idx-"));
    try {
      const bulk = path.join(dir, "all.jsonl.gz");
      const extra = { games: ["paper"], finishes: ["nonfoil"], set_name: "Commander Legends", released_at: "2020-11-20" };
      const tergrid = { ...rec("Tergrid"), ...extra };
      const tower = { ...rec("Command Tower"), ...extra };
      writeFileSync(bulk, gzipSync([tergrid, tower].map((c) => JSON.stringify(c)).join("\n")));
      const sets = [...new Set([tergrid.set, tower.set])].map((code) => ({ code, name: code, set_type: "expansion", released_at: "2020-01-01", card_count: 400 }));
      const file = path.join(dir, "cardindex.db");
      const idx = openIndex(file);
      await refreshIndex(idx, { source: bulk, setsSource: sets });
      const t = getPrinting(idx, tergrid.id);
      assert.equal(t.game_changer, 1);
      assert.equal(t.produced_mana, null);
      assert.equal(getPrinting(idx, tower.id).game_changer, 0);
      assert.deepEqual(JSON.parse(getPrinting(idx, tower.id).produced_mana).sort(), ["B", "G", "R", "U", "W"]);

      // The edits fallback (no network): the cards row gets the index facts.
      seedCollection(ctx.db, [[ID.sol, 1]]);
      ctx.db.prepare("UPDATE collection SET source = 'scan'").run();
      const fakeT = { ...t, oracle_id: "o-solring" }; // same-oracle edit target
      await editCopies(ctx.db, { items: [{ scryfall_id: ID.sol, finish: "normal", language: "en", condition: "near_mint", binder: "", quantity: 1 }],
        set: { printing_id: t.id } }, { getPrinting: (id) => (id === t.id ? fakeT : null), fetchCards: async () => { throw new Error("offline"); } });
      const row = ctx.db.prepare("SELECT game_changer, layout, fetched_at, cmc FROM cards WHERE scryfall_id = ?").get(t.id);
      assert.deepEqual({ ...row }, { game_changer: 1, layout: "modal_dfc", fetched_at: "", cmc: null });
      idx.close();

      const raw = new DatabaseSync(file);
      raw.exec("ALTER TABLE printings DROP COLUMN game_changer; ALTER TABLE printings DROP COLUMN produced_mana");
      raw.close();
      for (let i = 0; i < 2; i++) {
        const o = openIndex(file);
        const c = cols(o, "printings");
        assert.ok(c.includes("game_changer") && c.includes("produced_mana"));
        assert.equal(getPrinting(o, tergrid.id).game_changer, null, "NULL until the next refresh");
        o.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("companion", () => {
  test("a Companion section is a side row with companion, MTGA's sideboard copy is dropped", () => {
    const { items, errors } = parseDecklist([
      "Companion", "1 Lurrus of the Dream-Den", "", "Commander", "1 Atraxa, Praetors' Voice", "", "Deck", "1 Sol Ring", "",
      "Sideboard", "1 Lurrus of the Dream-Den", "2 Duress",
    ].join("\n"));
    assert.deepEqual(errors, []);
    assert.deepEqual(items.map((i) => [i.board, i.quantity, i.name, i.companion ?? false]), [
      ["side", 1, "Lurrus of the Dream-Den", true], ["commander", 1, "Atraxa, Praetors' Voice", false],
      ["main", 1, "Sol Ring", false], ["side", 2, "Duress", false],
    ]);
    assert.equal(parseDecklist("SB: 1 Lurrus of the Dream-Den").items[0].companion, undefined);
  });

  test("saved with companion = 1, carried by deckDetail, exported in its own section", async () => {
    const stub = stubScryfall();
    try {
      const { items } = parseDecklist("Companion\n1 Serra Angel\nCommander\n1 Atraxa, Praetors' Voice\nDeck\n1 Sol Ring\nSideboard\n1 Counterspell");
      const { id } = await saveDeck(ctx.db, { name: "C", format: "commander", items });
      const rows = ctx.db.prepare("SELECT name, board, companion FROM deck_cards WHERE deck_id = ? ORDER BY name").all(id).map((r) => [r.name, r.board, r.companion]);
      assert.deepEqual(rows, [["Atraxa, Praetors' Voice", "commander", 0], ["Counterspell", "side", 0], ["Serra Angel", "side", 1], ["Sol Ring", "main", 0]]);
      const d = deckDetail(ctx.db, id);
      const serra = d.cards.find((c) => c.name === "Serra Angel");
      assert.equal(serra.companion, 1);
      for (const k of ["oracle_text", "keywords", "legalities", "game_changer", "produced_mana", "layout", "fetched_at"]) assert.ok(k in serra, k);
      const text = exportDeck(d);
      assert.match(text, /^Companion\n1 Serra Angel \(DMU\) 33\n/);
      assert.doesNotMatch(text.split("Sideboard")[1], /Serra/);
      const again = parseDecklist(text).items.find((i) => i.name === "Serra Angel");
      assert.equal(again.companion, true);
    } finally {
      stub.restore();
    }
  });
});

