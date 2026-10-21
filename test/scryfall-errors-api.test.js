// HTTP status of Scryfall-calling routes when Scryfall is unreachable: every route
// that resolves card names maps the network failure to 502 (rules/api.md), never
// 500. Plus the binder-name limit of the card-list import. Real server, no network.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { seedCards } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

let srv, call, deckId;

before(async () => {
  srv = await startServer({
    name: "scryfall-errors",
    offline: true,
    seed: (dbFile) => {
      const db = openDb(dbFile);
      seedCards(db);
      deckId = Number(db.prepare("INSERT INTO decks (name) VALUES ('Burn')").run().lastInsertRowid);
      db.close();
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

describe("Scryfall unreachable", () => {
  test("import-list, deck add card and wishlist add answer 502, not 500", async () => {
    const cases = [
      ["/api/collection/import-list", { text: "1 Card Nobody Has Cached" }],
      [`/api/decks/${deckId}/cards`, { name: "Card Nobody Has Cached" }],
      ["/api/wishlist", { name: "Card Nobody Has Cached" }],
    ];
    for (const [path, body] of cases) {
      const r = await call("POST", path, body);
      assert.equal(r.status, 502, `${path}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Scryfall request failed/, path);
    }
    assert.doesNotMatch(srv.log(), /\[error\]/, "no stack traces for an outage");
  });

  test("import-list refuses a binder name above the limit instead of cutting it", async () => {
    const r = await call("POST", "/api/collection/import-list", { text: "1 Sol Ring", binder: "x".repeat(101) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /too long/);
  });
});
