// HTTP side of the wishlist and the Value tab: the boot seeds today's value
// snapshot, /api/wishlist CRUD (201 new / 200 merged, 400/404), the wishlist
// section of /api/shopping-list, the /api/finance/* views, and a collection
// write (delete) rewriting today's snapshot in the background. Real server on a
// free port, no card index, no Scryfall (the cards rows are seeded).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.js";
import { localDay } from "../lib/finance.js";
import { ID, seedCards } from "./fixtures.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base;
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-finance-api-"));
  const dbFile = path.join(dir, "app.db");
  const db = openDb(dbFile);
  seedCards(db);
  db.prepare(`INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES
    (?, 'normal', 'en', 'near_mint', 'Box', 2, 'app'), (?, 'foil', 'en', 'near_mint', '', 1, 'app')`).run(ID.sol, ID.lightning);
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "missing", "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_IMAGE_DIR: path.join(dir, "scans"), SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "",
      SPELLBOOK_ENABLED: "false",
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

after(async () => {
  if (proc && proc.exitCode == null) await new Promise((r) => { proc.once("exit", r); proc.kill("SIGKILL"); });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("value tab API", () => {
  test("boot seeds today's snapshot; summary, history, movers, top", async () => {
    const s = await call("GET", "/api/finance/summary");
    assert.equal(s.status, 200);
    assert.equal(s.body.history_start, localDay());
    assert.deepEqual([s.body.value_eur, s.body.copies, s.body.printings], [8, 3, 2]);
    assert.deepEqual(s.body.changes, { today: null, d7: null, d30: null });
    assert.deepEqual(s.body.binders.map((b) => [b.binder, b.value_eur]), [["", 5], ["Box", 3]]);
    const h = await call("GET", "/api/finance/history?days=30");
    assert.deepEqual(h.body.points.map((p) => p.value_eur), [8]);
    const m = await call("GET", "/api/finance/movers?days=7");
    assert.equal(m.body.available, false);
    const t = await call("GET", "/api/finance/top?limit=1");
    assert.deepEqual(t.body.cards.map((c) => [c.name, c.finish, c.price_eur]), [["Lightning Bolt", "foil", 5]]);
    const c = await call("GET", `/api/finance/card/${ID.sol}`);
    assert.deepEqual(c.body.points.map((p) => [p.quantity, p.eur]), [[2, 1.5]]);
    assert.equal((await call("GET", `/api/finance/card/${ID.sol}?finish=shiny`)).status, 400);
    assert.equal((await call("POST", "/api/finance/summary", {})).status, 405);
    assert.equal((await call("GET", "/api/finance/nope")).status, 404);
  });

  test("a collection delete rewrites today's snapshot in the background", async () => {
    const del = await call("POST", "/api/collection/delete", {
      items: [{ scryfall_id: ID.lightning, finish: "foil", language: "en", condition: "near_mint", binder: "", source: "app", quantity: 1 }], confirm: true,
    });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const deadline = Date.now() + 10000;
    let points;
    for (;;) {
      points = (await call("GET", `/api/finance/card/${ID.lightning}?finish=foil`)).body.points;
      if (points.at(-1)?.quantity === 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(points.length, 1, "same day: the row is rewritten");
    assert.equal(points[0].quantity, 0);
    assert.equal((await call("GET", "/api/finance/summary")).body.value_eur, 3);
  });
});

describe("wishlist API", () => {
  test("add, merge, list, patch, shopping list section, delete", async () => {
    const a = await call("POST", "/api/wishlist", { scryfall_id: ID.atraxa, quantity: 1, max_price_eur: 25 });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([a.body.merged, a.body.item.price_eur, a.body.item.below_max], [false, 20, true]);
    const b = await call("POST", "/api/wishlist", { scryfall_id: ID.atraxa, quantity: 1 });
    assert.equal(b.status, 200);
    assert.equal(b.body.item.quantity, 2);
    const id = a.body.item.id;
    assert.equal((await call("POST", "/api/wishlist", { name: "Sol Ring", quantity: 1 })).body.item.got_it, true);

    const list = await call("GET", "/api/wishlist");
    assert.deepEqual(list.body.items.map((i) => [i.name, i.got_it]), [["Atraxa, Praetors' Voice", false], ["Sol Ring", true]]);
    assert.equal(list.body.totals.to_buy_eur, 40);

    const p = await call("PATCH", `/api/wishlist/${id}`, { quantity: 1, priority: "high", note: "next order" });
    assert.deepEqual([p.status, p.body.quantity, p.body.priority, p.body.note], [200, 1, "high", "next order"]);
    assert.equal((await call("PATCH", `/api/wishlist/${id}`, { quantity: -2 })).status, 400);

    const shop = await call("GET", "/api/shopping-list");
    assert.ok(shop.body.built && shop.body.per_deck, "deck sections kept");
    assert.deepEqual(shop.body.wishlist.items.map((i) => [i.name, i.need, i.cost_eur]), [["Atraxa, Praetors' Voice", 1, 20]]);
    assert.equal(shop.body.wishlist.total_eur, 20);

    assert.equal((await call("POST", "/api/wishlist", { name: "" })).status, 400);
    assert.equal((await call("POST", "/api/wishlist", { scryfall_id: ID.sol, source: "claude" })).status, 400);
    assert.equal((await call("GET", `/api/wishlist/${id}`)).body.id, id);
    assert.equal((await call("DELETE", `/api/wishlist/${id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/wishlist/${id}`)).status, 404);
    assert.equal((await call("GET", "/api/wishlist/abc")).status, 404);
  });
});
