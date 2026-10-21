// Restore refusals and the restore window (server/routes/backups.js, server.js): a restore is refused
// (409) while an import holds the write lock or Claude writes a deck guide, and while a restore runs every
// other state-changing request answers 503. Each slow step is held open by a test-only preload: Scryfall
// answers late, the fake Claude CLI sleeps, the backup's gunzip waits before its first chunk.
// (Chat turns: chat-api.test.js; running scans: scan-cancel-api.test.js; in-flight requests: backups-api.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { ID, seedCards } from "./fixtures.js";
import { manaboxCsv, manaboxLine } from "./helpers/csv.js";
import { startServer } from "./helpers/server.js";

const preload = (code) => `--import=data:text/javascript,${encodeURIComponent(code)}`;
// After the Scryfall stub: /cards/collection answers 2 s late (the import then holds exclusive()).
const SLOW_SCRYFALL = preload(`const inner = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (String(url).includes("/cards/collection")) await new Promise((r) => setTimeout(r, 2000)); return inner(url, init); };`);
// Every gunzip waits 2 s before its first chunk (the restore then stays in its window).
const SLOW_GUNZIP = preload(`import zlib from "node:zlib";
const orig = zlib.Gunzip.prototype._transform, started = new WeakSet();
zlib.Gunzip.prototype._transform = function (c, e, cb) {
  if (started.has(this)) return orig.call(this, c, e, cb);
  started.add(this);
  setTimeout(() => orig.call(this, c, e, cb), 2000);
};`);
// The fake Claude CLI reads its prompt and sleeps 3 s (a deck guide being written).
const SLOW_CLI = `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => setTimeout(() => {}, 3000));\n`;

let srv, call, deckId;

before(async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };
  srv = await startServer({
    name: "restore-refusal",
    env,
    scryfall: true,
    nodeArgs: [SLOW_SCRYFALL, SLOW_GUNZIP],
    seed: (dbFile, dir) => {
      const db = openDb(dbFile);
      seedCards(db);
      deckId = Number(db.prepare("INSERT INTO decks (name, format) VALUES ('Guide me', 'commander')").run().lastInsertRowid);
      db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, 'main', 'Sol Ring', ?, 1)").run(deckId, ID.sol);
      db.close();
      const bin = path.join(dir, "fake-claude");
      writeFileSync(bin, SLOW_CLI);
      chmodSync(bin, 0o755);
      env.CLAUDE_BIN = bin; // startServer spreads env when it spawns, after seed
    },
  });
  call = srv.call;
});

after(() => srv?.stop());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const restore = (name) => call("POST", `/api/backups/${name}/restore`, { confirm: true });

describe("restore refusals", { skip: process.platform === "win32" && "needs a shebang fake CLI" }, () => {
  let backup;
  before(async () => { backup = (await call("POST", "/api/backups")).body.name; });

  test("refused while an import holds the write lock", async () => {
    const csv = manaboxCsv(manaboxLine("Box", "Sol Ring", "c21", "263", "1", ID.sol));
    const importing = call("POST", "/api/import/manabox?mode=add", csv, { "Content-Type": "text/csv" });
    await wait(500); // the import waits for Scryfall inside exclusive()
    const r = await restore(backup);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /an import, price refresh or collection change is running/);
    assert.equal((await importing).status, 200);
  });

  test("refused while Claude writes a deck guide", async () => {
    assert.equal((await call("POST", `/api/decks/${deckId}/guide`, {})).status, 202);
    const r = await restore(backup);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Claude is writing a deck guide/);
    // The job ends (the fake CLI answers nothing): then the restore is allowed again.
    const deadline = Date.now() + 15000;
    while ((await call("GET", `/api/decks/${deckId}/guide`)).body.status === "pending" && Date.now() < deadline) await wait(200);
  });

  test("while a restore runs, other writes answer 503; afterwards the app writes again", async () => {
    const restoring = restore(backup);
    await wait(500); // the restore waits in its (slowed) gunzip
    const during = await call("POST", "/api/binders", { name: "During restore" });
    assert.equal(during.status, 503);
    assert.match(during.body.error, /backup is being restored/);
    assert.equal((await call("GET", "/api/binders")).status, 200, "reads still work");
    const done = await restoring;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await call("POST", "/api/binders", { name: "After restore" })).status, 201);
  });
});
