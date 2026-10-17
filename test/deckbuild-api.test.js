// HTTP layer of the build checklist and deck history (server.js): routes, status
// codes, the confirm flag of a restore, PATCH recording a version and
// "Put into deck box" for the picked cards only. Real server, seeded temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.js";
import { recordDeckVersion } from "../lib/deckhistory.js";
import { ID, seedCards } from "./fixtures.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base, deckId;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-deckbuild-"));
  const dbFile = path.join(dir, "app.db");
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
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", SPELLBOOK_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, json) {
  const init = { method, headers: {} };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

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
