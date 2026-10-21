// HTTP layer of the build checklist and deck history (server.js): routes, status
// codes, the confirm flag of a restore, PATCH recording a version and
// "Put into deck box" for the picked cards only. Real server, seeded temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { recordDeckVersion } from "../lib/deckhistory.js";
import { ID, seedCards } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

let srv, call, deckId;

before(async () => {
  srv = await startServer({
    name: "deckbuild",
    seed: (dbFile) => {
      const db = openDb(dbFile);
      seedCards(db);
      const own = db.prepare("INSERT INTO collection (scryfall_id, binder, quantity, source) VALUES (?, ?, ?, 'app')");
      own.run(ID.sol, "Box A", 1);
      own.run(ID.lightning, "", 2);
      deckId = Number(db.prepare("INSERT INTO decks (name) VALUES ('Burn')").run().lastInsertRowid);
      const card = db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, 'main', ?, ?, ?)");
      card.run(deckId, "Sol Ring", ID.sol, 1);
      card.run(deckId, "Lightning Bolt", ID.lightning, 2);
      card.run(deckId, "Counterspell", ID.counterspell, 1);
      recordDeckVersion(db, deckId, { actor: "app" });
      db.close();
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

describe("build checklist API", () => {
  test("GET /api/decks/:id/build groups the deck; 404 for a missing deck", async () => {
    const r = await call("GET", `/api/decks/${deckId}/build`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups.map((g) => [g.kind, g.title]), [["binder", "Unsorted"], ["binder", "Box A"], ["buy", "To buy"]]);
    assert.deepEqual([r.body.total, r.body.picked], [4, 0]);
    assert.equal((await call("GET", "/api/decks/9999/build")).status, 404);
  });

  test("PUT/DELETE picks; to-binder picked_only moves the ticked cards only", async () => {
    assert.equal((await call("POST", `/api/decks/${deckId}/to-binder`, { picked_only: true })).status, 400, "nothing picked yet");
    let r = await call("PUT", `/api/decks/${deckId}/build/picks`, { key: "o-solring", source: "b:box a", quantity: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.picked, r.body.movable_picked], [1, 1]);
    assert.equal((await call("PUT", `/api/decks/${deckId}/build/picks`, { key: "o-solring", source: "b:box a", quantity: "1" })).status, 400);
    assert.equal((await call("PUT", `/api/decks/${deckId}/build/picks`, { key: "o-x", source: "buy", quantity: 1 })).status, 404);
    r = await call("POST", `/api/decks/${deckId}/to-binder`, { picked_only: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.binder, r.body.moved_copies], ["Deck box: Burn", 1]);
    r = await call("GET", `/api/decks/${deckId}/build`);
    assert.deepEqual(r.body.groups.map((g) => g.kind), ["binder", "buy", "box"]);
    await call("PUT", `/api/decks/${deckId}/build/picks`, { key: "o-counter", source: "buy", quantity: 1 });
    r = await call("DELETE", `/api/decks/${deckId}/build/picks`);
    assert.deepEqual([r.status, r.body.picked], [200, 1], "boxed copies stay picked");
    assert.equal((await call("POST", `/api/decks/${deckId}/build`)).status, 405);
  });
});

describe("favourites + binder search API", () => {
  test("PATCH favorite: no history version, no updated_at change; list rows carry favorite + colors", async () => {
    const before = (await call("GET", `/api/decks/${deckId}/history`)).body.versions.length;
    const row0 = (await call("GET", "/api/decks")).body.find((d) => d.id === deckId);
    assert.deepEqual([row0.favorite, typeof row0.colors], [false, "string"]);
    let r = await call("PATCH", `/api/decks/${deckId}`, { favorite: true });
    assert.deepEqual([r.status, r.body.favorite], [200, true]);
    const row = (await call("GET", "/api/decks")).body.find((d) => d.id === deckId);
    assert.deepEqual([row.favorite, row.updated_at], [true, row0.updated_at]);
    assert.equal((await call("GET", `/api/decks/${deckId}/history`)).body.versions.length, before);
    assert.equal((await call("PATCH", `/api/decks/${deckId}`, { favorite: "yes" })).status, 400);
    r = await call("PATCH", `/api/decks/${deckId}`, { favorite: false });
    assert.equal(r.body.favorite, false);
    // A 400 on another field writes nothing, not even the favourite flag.
    assert.equal((await call("PATCH", `/api/decks/${deckId}`, { favorite: true, bracket_declared: 9 })).status, 400);
    assert.equal((await call("GET", "/api/decks")).body.find((d) => d.id === deckId).favorite, false);
  });

  test("binder favourite via PATCH; GET /api/binders/search", async () => {
    let r = await call("PATCH", `/api/binders/${encodeURIComponent("Box A")}`, { favorite: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.binders.find((b) => b.name === "Box A").favorite, true);
    // Lightning Bolt stays in Unsorted (the build tests above moved Sol Ring into the deck box).
    r = await call("GET", `/api/binders/search?q=${encodeURIComponent("lightning")}`);
    assert.deepEqual([r.status, r.body.cards, r.body.binders], [200, 1, [{ name: "", cards: 1, copies: 2 }]]);
    assert.equal((await call("GET", "/api/binders/search?q=zzz:1")).status, 400);
  });
});

describe("deck history API", () => {
  test("PATCH and card edits add versions; detail shows the diff; restore needs confirm", async () => {
    assert.equal((await call("PATCH", `/api/decks/${deckId}`, { name: "Burn!", bracket_declared: 2 })).status, 200);
    assert.equal((await call("PATCH", `/api/decks/${deckId}/cards`, { name: "Counterspell", board: "main", quantity: 0 })).status, 200);
    let r = await call("GET", `/api/decks/${deckId}/history`);
    assert.equal(r.status, 200);
    const v = r.body.versions;
    assert.deepEqual(v.map((x) => [x.actor, x.summary]), [
      ["app", "−1 card"], ["app", 'renamed to "Burn!" · bracket 2'], ["app", "Created · 4 cards"],
    ]);
    assert.equal(r.body.keep, 50);

    r = await call("GET", `/api/decks/${deckId}/history/${v[0].id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.diff.boards, [{ board: "main", added: [], removed: [{ name: "Counterspell", quantity: 1 }], changed: [] }]);
    assert.equal(r.body.restore.summary, "No changes");

    const oldest = v.at(-1).id;
    assert.equal((await call("POST", `/api/decks/${deckId}/history/${oldest}/restore`, {})).status, 400);
    r = await call("POST", `/api/decks/${deckId}/history/${oldest}/restore`, { confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "Burn");
    assert.equal(r.body.restored.restored_from, oldest);
    assert.ok(r.body.cards.some((c) => c.name === "Counterspell"));
    r = await call("GET", `/api/decks/${deckId}/history`);
    assert.equal(r.body.versions.length, 4);
    assert.equal(r.body.versions[0].current, true);
    assert.equal((await call("GET", `/api/decks/${deckId}/history/999999`)).status, 404);
    assert.equal((await call("GET", "/api/decks/9999/history")).status, 404);
  });
});
