// HTTP layer of the ManaBox import's binder targeting (?binder=, ?create_binder=1) and of the
// paging clamps of GET /api/collection. Real server, Scryfall stubbed from the fixture pool.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db.js";
import { ID, seedCards, seedCollection } from "./fixtures.js";
import { manaboxCsv, manaboxLine } from "./helpers/csv.js";
import { startServer } from "./helpers/server.js";

let srv, call;

before(async () => {
  srv = await startServer({
    name: "import-binder",
    scryfall: true,
    seed: (dbFile) => {
      const db = openDb(dbFile);
      seedCards(db);
      seedCollection(db, [[ID.lightning, 1], [ID.serra, 1], [ID.counterspell, 1]]); // rows to page through
      db.prepare("INSERT INTO binders (name, origin) VALUES ('Trade Binder', 'app')").run();
      db.close();
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

const CSV = manaboxCsv(manaboxLine("Box", "Sol Ring", "c21", "263", "1", ID.sol));
const importTo = (query) => call("POST", `/api/import/manabox?mode=add&${query}`, CSV, { "Content-Type": "text/csv" });
const binderOf = async () => (await call("GET", `/api/cards/${ID.sol}`)).body.owned.map((r) => r.binder);

describe("POST /api/import/manabox ?binder=", () => {
  test("an unknown binder is 404 unless create_binder=1; too long is 400", async () => {
    let r = await importTo("binder=Nowhere");
    assert.equal(r.status, 404);
    assert.match(r.body.error, /create_binder=1/);
    r = await importTo(`binder=${"x".repeat(101)}`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /too long/);
    assert.deepEqual(await binderOf(), [], "nothing imported");
  });

  test("an existing binder matches case-insensitively and keeps its spelling", async () => {
    const r = await importTo("binder=trade%20binder");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await binderOf(), ["Trade Binder"]);
  });

  test("create_binder=1 creates it; an empty binder= means Unsorted", async () => {
    let r = await importTo("binder=New%20Box&create_binder=1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.binders_created.includes("New Box"));
    r = await importTo("binder=");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await binderOf()).sort(), ["", "New Box", "Trade Binder"]);
  });
});

describe("GET /api/collection paging", () => {
  test("limit and offset are clamped, 0 and junk fall back to the default 60", async () => {
    const page = async (q) => (await call("GET", `/api/collection?${q}`)).body;
    const all = await page("");
    assert.ok(all.total >= 3);
    for (const [q, rows] of [["limit=0", Math.min(60, all.total)], ["limit=abc", Math.min(60, all.total)], ["limit=9999", Math.min(500, all.total)], ["limit=1&offset=-5", 1]]) {
      const r = await page(q);
      assert.equal(r.rows.length, rows, q);
      assert.equal(r.total, all.total, q);
    }
    assert.deepEqual((await page("limit=1&offset=-5")).rows[0].name, all.rows[0].name, "negative offset = 0");
  });
});
