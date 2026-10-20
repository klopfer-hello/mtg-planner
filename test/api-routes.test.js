// HTTP routes no other API test covers: chats (without Claude), query help,
// collection CSV export, text card lists, set completion, price refresh and
// the import log, deck export / commander / bulk edits / facts-only guide +
// PDF, scan list odds and ends (undo, images, truth), printing pickers and the
// card index jobs, plus the router's 404/405 answers. Real server.js against a
// seeded temp DB; Scryfall answers from the fixture pool (no network).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { saveDeckRows } from "../lib/decks.js";
import { ID, seedCards, seedCollection } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

let srv, call, deckId, deck2;

before(async () => {
  srv = await startServer({
    name: "api-routes",
    scryfall: true,
    env: { INDEX_BULK_SOURCE: "/nonexistent/all_cards.jsonl.gz" },
    seed: (dbFile) => {
      const db = openDb(dbFile);
      seedCards(db);
      seedCollection(db, [[ID.sol, 2, { binder: "Box" }], [ID.lightning, 1], [ID.atraxa, 1, { binder: "Box" }]]);
      deckId = saveDeckRows(db, {
        name: "Atraxa Counters", format: "commander", source: "manual",
        rows: [
          { board: "commander", name: "Atraxa, Praetors' Voice", scryfall_id: ID.atraxa, quantity: 1 },
          { board: "main", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
          { board: "main", name: "Counterspell", scryfall_id: ID.counterspell, quantity: 1 },
        ],
      });
      deck2 = saveDeckRows(db, {
        name: "Red Pile", source: "manual",
        rows: [
          { board: "main", name: "Lightning Bolt", scryfall_id: ID.lightning, quantity: 4 },
          { board: "main", name: "Serra Angel", scryfall_id: ID.serra, quantity: 1 },
          { board: "side", name: "Sol Ring", scryfall_id: ID.sol, quantity: 1 },
        ],
      });
      db.close();
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

describe("router answers", () => {
  test("unknown API path 404, known path with another method 405, unknown chat 404 'Chat not found'", async () => {
    const nope = await call("GET", "/api/nope");
    assert.deepEqual([nope.status, nope.body], [404, { error: "Not found" }]);
    assert.equal((await call("PUT", "/api/decks")).status, 405);
    assert.equal((await call("PUT", `/api/decks/${deckId}`)).status, 405);
    assert.deepEqual((await call("GET", "/api/chats/not-a-uuid")).body, { error: "Chat not found" });
    assert.deepEqual((await call("GET", "/api/cards/xyz")).body, { error: "Card not found" });
    assert.equal((await call("GET", "/api")).status, 404);
  });

  test("static: index.html for app routes, 404 for missing assets", async () => {
    const page = await call("GET", "/decks/1");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal((await call("GET", "/nope.js")).status, 404);
    assert.equal((await call("POST", "/index.html", {})).status, 405);
  });
});

describe("chats without Claude", () => {
  test("create, list, read, refuse a message (no token), delete", async () => {
    const created = await call("POST", "/api/chats", { title: "  Deck ideas  " });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, "Deck ideas");
    assert.match(created.body.id, /^[0-9a-f-]{36}$/);
    const id = created.body.id;
    assert.equal((await call("POST", "/api/chats", {})).body.title, "New chat");
    const list = await call("GET", "/api/chats");
    assert.ok(list.body.some((c) => c.id === id));
    const one = await call("GET", `/api/chats/${id.toUpperCase()}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.messages, []);
    assert.equal(one.body.busy, false);
    assert.equal("session_id" in one.body.chat, false, "the CLI session stays private");
    assert.equal((await call("POST", `/api/chats/${id}/messages`, {})).status, 400, "text is required");
    const msg = await call("POST", `/api/chats/${id}/messages`, { text: "hi" });
    assert.equal(msg.status, 503);
    assert.match(msg.body.error, /not configured/);
    assert.equal((await call("GET", `/api/chats/${id}/messages`)).status, 405);
    assert.equal((await call("POST", "/api/chats", { title: 5 })).status, 400);
    assert.equal((await call("DELETE", `/api/chats/${id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/chats/${id}`)).status, 404);
    assert.equal((await call("GET", `/api/chats/${id}`)).status, 404);
  });
});

describe("collection extras", () => {
  test("GET /api/query-help", async () => {
    const r = await call("GET", "/api/query-help");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.help) || typeof r.body.help === "string");
    assert.match(JSON.stringify(r.body.help), /t:type/);
  });

  test("GET /api/collection/export: ManaBox CSV, plain CSV, per binder, bad format", async () => {
    const all = await call("GET", "/api/collection/export");
    assert.equal(all.status, 200);
    assert.match(all.headers.get("content-type"), /^text\/csv/);
    assert.match(all.headers.get("content-disposition"), /filename="mtg-planner collection\.csv"/);
    assert.match(all.body, /Sol Ring/);
    assert.match(all.body, /Lightning Bolt/);
    const box = await call("GET", "/api/collection/export?binder=Box&format=csv");
    assert.match(box.headers.get("content-disposition"), /filename="mtg-planner Box\.csv"/);
    assert.doesNotMatch(box.body, /Lightning Bolt/);
    assert.match(box.body.split("\r\n")[0] ?? box.body.split("\n")[0], /price/i);
    const unsorted = await call("GET", "/api/collection/export?binder=");
    assert.match(unsorted.headers.get("content-disposition"), /mtg-planner Unsorted\.csv/);
    assert.equal((await call("GET", "/api/collection/export?format=xlsx")).status, 400);
  });

  test("POST /api/collection/import-list: copies into a binder, optional built deck, one undoable log entry", async () => {
    assert.equal((await call("POST", "/api/collection/import-list", { text: "  " })).status, 400);
    assert.equal((await call("POST", "/api/collection/import-list", { text: "1 No Such Card Anywhere" })).status, 400);
    const r = await call("POST", "/api/collection/import-list", {
      text: "Commander\n1 Atraxa, Praetors' Voice\nDeck\n2 Serra Angel\n1 Counterspell (MH2) 267\nnot a line",
      binder: "Precon Box", language: "de", deck: { name: "Precon", format: "Commander" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.binder, "Precon Box");
    assert.equal(r.body.created, true);
    assert.equal(r.body.added_copies, 4);
    assert.deepEqual(r.body.parse_errors, ["not a line"]);
    assert.ok(r.body.edit_id);
    assert.ok(r.body.deck_id);
    const serra = (await call("GET", `/api/cards/${ID.serra}`)).body.owned;
    assert.deepEqual(serra.map((o) => [o.binder, o.language, o.source, o.quantity]), [["Precon Box", "de", "app", 2]]);
    const deck = (await call("GET", `/api/decks/${r.body.deck_id}`)).body;
    assert.equal(deck.status, "built");
    assert.equal(deck.format, "commander");
    assert.equal(deck.box_binder, "Precon Box");
    const edits = (await call("GET", "/api/collection/edits")).body.edits;
    assert.equal(edits[0].id, r.body.edit_id);
    assert.equal(edits[0].kind, "add");
  });

  test("set completion: lists from the (empty) card index, unknown set 404", async () => {
    const r = await call("GET", "/api/sets");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.sets));
    assert.equal((await call("GET", "/api/sets/zzz")).status, 404);
    assert.equal((await call("GET", "/api/sets/a")).status, 404, "set codes are 2-8 characters");
  });

  test("POST /api/refresh-prices and GET /api/imports", async () => {
    const r = await call("POST", "/api/refresh-prices");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const imports = await call("GET", "/api/imports");
    assert.equal(imports.status, 200);
    assert.ok(Array.isArray(imports.body));
    for (const row of imports.body) assert.equal(typeof row.summary, "object");
  });
});

describe("decks", () => {
  test("GET /api/decks/:id/export: importable text as a download", async () => {
    const r = await call("GET", `/api/decks/${deckId}/export`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/plain/);
    assert.match(r.headers.get("content-disposition"), /filename="Atraxa Counters\.txt"/);
    // Boards in order, cards by mana value: a re-import gives the same deck.
    assert.equal(r.body, "Commander\n1 Atraxa, Praetors' Voice (2XM) 190\n\nDeck\n1 Sol Ring (C21) 263\n1 Counterspell (MH2) 267\n");
    assert.equal((await call("GET", "/api/decks/99999/export")).status, 404);
  });

  test("POST /api/decks/:id/commander and /cards/bulk", async () => {
    let r = await call("POST", `/api/decks/${deck2}/commander`, { name: "Serra Angel" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.change.commanders, ["Serra Angel"]);
    assert.equal(r.body.counts.commander, 1);
    assert.equal((await call("POST", `/api/decks/${deck2}/commander`, { name: "Black Lotus" })).status, 404);
    r = await call("POST", `/api/decks/${deck2}/cards/bulk`, { action: "move", to_board: "maybe", items: [{ name: "Sol Ring", board: "side" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.change.rows, r.body.change.copies, r.body.counts.maybe, r.body.counts.side], [1, 1, 1, 0]);
    r = await call("POST", `/api/decks/${deck2}/cards/bulk`, { action: "remove", items: [{ name: "Lightning Bolt", board: "main" }] });
    assert.equal(r.body.counts.main, 0);
    assert.equal((await call("POST", `/api/decks/${deck2}/cards/bulk`, { action: "burn", items: [] })).status, 400);
    assert.equal((await call("POST", `/api/decks/${deck2}/cards/bulk`, { action: "remove", items: [{ name: "Nope", board: "main" }] })).status, 404);
    const history = (await call("GET", `/api/decks/${deck2}/history`)).body;
    assert.ok(history.versions.length >= 3, "commander + two bulk edits are versions");
  });

  test("deck guide without Claude: none → facts-only guide (201) → ready → PDF", async () => {
    let r = await call("GET", `/api/decks/${deckId}/guide`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "none");
    assert.equal(r.body.claude, false);
    assert.equal((await call("GET", `/api/decks/${deckId}/guide.pdf`)).status, 404);
    r = await call("POST", `/api/decks/${deckId}/guide`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "ready");
    assert.equal(r.body.guide.kind, "facts");
    const detail = (await call("GET", `/api/decks/${deckId}`)).body;
    assert.equal(detail.guide.kind, "facts");
    assert.equal(detail.guide.pending, false);
    const pdf = await call("GET", `/api/decks/${deckId}/guide.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(pdf.headers.get("content-disposition"), /filename="Atraxa Counters - guide\.pdf"/);
    assert.equal(Buffer.from(pdf.body).subarray(0, 5).toString(), "%PDF-");
    assert.equal((await call("GET", "/api/decks/99999/guide")).status, 404);
    assert.equal((await call("POST", "/api/decks/99999/guide", {})).status, 404);
  });
});

describe("scanner odds and ends", () => {
  test("undo on an empty list, images/strips/truth of missing scans", async () => {
    assert.deepEqual((await call("POST", "/api/scans/undo")).body, { undone: null, scan: null, unconfirmed: [] });
    assert.equal((await call("GET", "/api/scans/1/image")).status, 404);
    assert.equal((await call("GET", "/api/scans/1/strip")).status, 404);
    assert.equal((await call("POST", "/api/scans/1/image")).status, 405);
    assert.equal((await call("POST", "/api/scans/999/truth", { printing_id: ID.sol })).status, 404);
  });

  test("printing pickers validate their input", async () => {
    assert.equal((await call("GET", "/api/printings")).status, 400);
    assert.deepEqual((await call("GET", "/api/printings?oracle_id=o-none")).body, []);
    assert.deepEqual((await call("GET", "/api/printings/search?q=x")).body, [], "one letter is no search");
    assert.deepEqual((await call("GET", "/api/printings/search?q=sol%20ring")).body, []);
  });

  test("index jobs: refresh (202) fails without a bulk file, one job at a time, fingerprints after it", async () => {
    const r = await call("POST", "/api/index/refresh");
    assert.equal(r.status, 202);
    assert.equal(r.body.started.kind, "refresh");
    const wait = async () => {
      for (let i = 0; i < 100; i++) {
        const st = (await call("GET", "/api/index/status")).body;
        if (!st.job) return st;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error("index job did not finish");
    };
    let st = await wait();
    assert.equal(st.last_job.kind, "refresh");
    assert.equal(st.last_job.ok, false);
    assert.equal(st.refresh_job.kind, "refresh");
    assert.equal(st.scheduler.enabled, false);
    const fp = await call("POST", "/api/index/fingerprints");
    assert.equal(fp.status, 202);
    assert.equal(fp.body.started.kind, "fingerprints");
    st = await wait();
    assert.equal(st.last_job.kind, "fingerprints");
  });
});
