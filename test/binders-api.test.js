// HTTP layer of the binder routes (server.js): status codes, validation, the
// confirm_master / confirm_replace error codes and the CSRF / content-type
// guards. Starts the real server on a free port against a seeded temp DB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.js";
import { ID, seedCards } from "./fixtures.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-api-"));
  const dbFile = path.join(dir, "app.db");
  const db = openDb(dbFile);
  seedCards(db);
  const ins = db.prepare("INSERT INTO collection (scryfall_id, finish, language, condition, binder, quantity, source) VALUES (?, 'normal', 'en', 'near_mint', ?, ?, ?)");
  ins.run(ID.sol, "Box", 3, "manabox");
  ins.run(ID.lightning, "Scans", 2, "scan");
  ins.run(ID.serra, "", 1, "manabox");
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "",
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

async function call(method, p, json, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["Content-Type"] ??= "application/json"; }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const enc = encodeURIComponent;

describe("binder API", () => {
  test("GET /api/stats?binder= counts and values one binder (case-insensitive, empty = Unsorted)", async () => {
    const all = (await call("GET", "/api/stats")).body;
    assert.equal(all.binder, undefined);
    assert.equal(all.total_cards, 6);
    assert.equal(all.value_eur, 3 * 1.5 + 2 * 2 + 0.1);
    const box = (await call("GET", "/api/stats?binder=box")).body;
    assert.deepEqual([box.binder, box.total_cards, box.unique_cards, box.printings, box.value_eur], ["box", 3, 1, 1, 4.5]);
    assert.equal(box.decks, all.decks);
    assert.equal(box.collection_master, "manabox");
    const unsorted = (await call("GET", "/api/stats?binder=")).body;
    assert.deepEqual([unsorted.binder, unsorted.total_cards, unsorted.value_eur], ["", 1, 0.1]);
    const none = (await call("GET", "/api/stats?binder=Nope")).body;
    assert.deepEqual([none.total_cards, none.unique_cards, none.value_eur], [0, 0, 0]);
  });
  test("GET /api/binders lists binders and the unsorted bucket; settings and stats expose the master", async () => {
    const { status, body } = await call("GET", "/api/binders");
    assert.equal(status, 200);
    assert.deepEqual(body.binders.map((b) => [b.name, b.copies]), [["Box", 3], ["Scans", 2]]);
    assert.equal(body.unsorted.copies, 1);
    assert.equal(body.collection_master, "manabox");
    assert.equal((await call("GET", "/api/settings")).body.collection_master, "manabox");
    assert.equal((await call("GET", "/api/stats")).body.collection_master, "manabox");
  });

  test("GET /api/binders: type, value, cover; PATCH type / cover_scryfall_id", async () => {
    const body = (await call("GET", "/api/binders")).body;
    const box = body.binders.find((b) => b.name === "Box");
    assert.deepEqual([box.type, box.type_auto, box.type_set, box.type_suggest, box.value_eur], ["binder", "binder", false, null, 4.5]);
    assert.deepEqual([box.cover.scryfall_id, box.cover.chosen, box.top.name], [ID.sol, false, "Sol Ring"]);
    assert.equal(body.unsorted.value_eur, 0.1);
    assert.equal(body.unsorted.cover.scryfall_id, ID.serra);
    let r = await call("PATCH", `/api/binders/${enc("box")}`, { type: "trade" });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "Box");
    assert.deepEqual(["type", "type_set"].map((k) => r.body.binders.find((b) => b.name === "Box")[k]), ["trade", true]);
    assert.equal((await call("PATCH", `/api/binders/${enc("Box")}`, { type: "shoebox" })).status, 400);
    assert.equal((await call("PATCH", `/api/binders/${enc("Box")}`, { cover_scryfall_id: ID.lightning })).status, 400, "not in Box");
    assert.equal((await call("PATCH", `/api/binders/${enc("Nope")}`, { type: "bulk" })).status, 404);
    r = await call("PATCH", `/api/binders/${enc("Scans")}`, { cover_scryfall_id: ID.lightning, type: null });
    assert.equal(r.status, 200);
    const scans = r.body.binders.find((b) => b.name === "Scans");
    assert.deepEqual([scans.cover.scryfall_id, scans.cover.chosen, scans.type_set], [ID.lightning, true, false]);
    r = await call("PATCH", `/api/binders/${enc("Box")}`, { type: "auto" });
    assert.equal(r.body.binders.find((b) => b.name === "Box").type_set, false);
  });

  test("GET /api/collection/sections + section filter on /api/collection", async () => {
    let r = await call("GET", "/api/collection/sections?by=type");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sections.map((s) => [s.key, s.label, s.cards, s.copies]),
      [["creature", "Creatures", 1, 1], ["instant", "Instants", 1, 2], ["artifact", "Artifacts", 1, 3]]);
    r = await call("GET", `/api/collection/sections?by=set&binder=${enc("box")}`);
    assert.deepEqual(r.body.sections.map((s) => [s.key, s.label, s.value_eur]), [["c21", "Commander 2021", 4.5]]);
    r = await call("GET", "/api/collection/sections?by=color&q=t%3Ainstant");
    assert.deepEqual(r.body.sections.map((s) => s.key), ["R"]);
    assert.equal((await call("GET", "/api/collection/sections?by=artist")).status, 400);
    assert.equal((await call("GET", "/api/collection/sections?q=foo%3Abar")).status, 400);
    r = await call("GET", "/api/collection?section_by=rarity&section=uncommon");
    assert.deepEqual(r.body.rows.map((x) => x.name).sort(), ["Serra Angel", "Sol Ring"]);
    assert.equal((await call("GET", "/api/collection?section_by=nope&section=x")).status, 400);
  });

  test("POST /api/binders: 201, 409 duplicate, 400 empty/too long, 415 wrong type, 403 cross-site", async () => {
    let r = await call("POST", "/api/binders", { name: "Trade" });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, "Trade");
    assert.equal((await call("POST", "/api/binders", { name: "trade" })).status, 409);
    assert.equal((await call("POST", "/api/binders", { name: "" })).status, 400);
    assert.equal((await call("POST", "/api/binders", { name: "x".repeat(101) })).status, 400);
    assert.equal((await call("POST", "/api/binders", { name: "T2" }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await call("POST", "/api/binders", { name: "T3" }, { Origin: "http://evil.example" })).status, 403);
    r = await call("GET", "/api/binders");
    assert.ok(r.body.binders.some((b) => b.name === "Trade" && b.empty));
  });

  test("POST /api/collection/move: validation, confirm_master flow, collection filter", async () => {
    assert.equal((await call("POST", "/api/collection/move", { items: [], to_binder: "Trade" })).status, 400);
    assert.equal((await call("POST", "/api/collection/move", { items: "x", to_binder: "Trade" })).status, 400);
    assert.equal((await call("POST", "/api/collection/move", { items: [{ scryfall_id: ID.lightning, binder: "Scans", quantity: 1 }], to_binder: "Nope" })).status, 404);
    let r = await call("POST", "/api/collection/move", { items: [{ scryfall_id: ID.lightning, binder: "Scans", quantity: 1 }], to_binder: "Trade" });
    assert.equal(r.status, 200);
    assert.equal(r.body.moved_copies, 1);
    const move = { items: [{ scryfall_id: ID.sol, binder: "Box", quantity: 2 }], to_binder: "Trade" };
    r = await call("POST", "/api/collection/move", move);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "confirm_master");
    assert.equal(r.body.manabox_copies, 2);
    r = await call("POST", "/api/collection/move", { ...move, confirm_master: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.converted_copies, r.body.collection_master], [2, "app"]);
    r = await call("GET", `/api/collection?binder=${enc("trade")}`);
    assert.deepEqual(r.body.rows.map((x) => [x.name, x.qty]).sort(), [["Lightning Bolt", 1], ["Sol Ring", 2]]);
    r = await call("GET", "/api/collection?binder=");
    assert.deepEqual(r.body.rows.map((x) => x.name), ["Serra Angel"]);
    // Card detail rows carry source and id for the per-row Move action.
    r = await call("GET", `/api/cards/${ID.sol}`);
    assert.deepEqual(r.body.owned.map((o) => [o.binder, o.source, o.quantity]), [["Box", "manabox", 1], ["Trade", "app", 2]]);
    assert.ok(r.body.owned.every((o) => Number.isInteger(o.id)));
  });

  test("PATCH / DELETE /api/binders/:name", async () => {
    let r = await call("PATCH", `/api/binders/${enc("Scans")}`, { name: "Trade" });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.name, r.body.merged], ["Trade", true]);
    assert.equal((await call("PATCH", `/api/binders/${enc("Nope")}`, { name: "X" })).status, 404);
    assert.equal((await call("PATCH", `/api/binders/${enc("Trade")}`, { name: " " })).status, 400);
    assert.equal((await call("DELETE", `/api/binders/${enc("Trade")}?cards=burn`)).status, 400);
    r = await call("DELETE", `/api/binders/${enc("Box")}?cards=unsort`);
    assert.equal(r.status, 200);
    assert.equal(r.body.unsorted_copies, 1);
    r = await call("DELETE", `/api/binders/${enc("Trade")}?cards=delete`);
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted_copies, 4, "master is app: app + scan rows go");
    assert.deepEqual((await call("GET", "/api/binders")).body.binders, []);
  });

  test("import guard and master switch-back via PATCH /api/settings", async () => {
    let r = await call("POST", "/api/import/manabox?mode=replace", undefined, { "Content-Type": "text/csv" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "confirm_replace");
    assert.equal((await call("PATCH", "/api/settings", { collection_master: "nope" })).status, 400);
    r = await call("PATCH", "/api/settings", { collection_master: "manabox" });
    assert.equal(r.body.collection_master, "manabox");
    // Back to ManaBox as master: replace passes the guard again (fails later on the empty body).
    r = await call("POST", "/api/import/manabox?mode=replace", undefined, { "Content-Type": "text/csv" });
    assert.equal(r.status, 400);
  });
});

describe("deck allocation API", () => {
  test("status, conflicts, shopping list, card usage, put into deck box", async () => {
    // Left from above: Sol Ring 1 (Unsorted, app), Serra Angel 1 (Unsorted, manabox); master manabox.
    let r = await call("POST", "/api/decks", { name: "Built1", text: "1 Sol Ring\n1 Serra Angel", status: "built" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const built = r.body.id;
    r = await call("POST", "/api/decks", { name: "Idea1", text: "1 Sol Ring" });
    const idea = r.body.id;
    assert.equal((await call("POST", "/api/decks", { name: "Bad", text: "1 Sol Ring", status: "done" })).status, 400);
    let list = (await call("GET", "/api/decks")).body;
    assert.deepEqual(list.map((d) => [d.name, d.status, d.conflict_count]).sort(), [["Built1", "built", 0], ["Idea1", "idea", 0]]);
    let d = (await call("GET", `/api/decks/${idea}`)).body;
    const sol = d.cards.find((c) => c.name === "Sol Ring");
    assert.deepEqual([sol.owned, sol.available_for_this, sol.missing, sol.to_buy, sol.in_use, sol.conflict], [1, 0, 0, 0, 1, false]);
    assert.deepEqual([d.missing_count, d.to_buy_count, d.in_use_count, d.in_use_eur], [0, 0, 1, 1.5]);
    assert.deepEqual(d.shopping.in_use.map((i) => [i.name, i.quantity, i.decks, i.conflict]), [["Sol Ring", 1, [{ id: built, name: "Built1" }], false]]);
    assert.deepEqual(sol.used_elsewhere.map((u) => [u.deck_id, u.name, u.status, u.quantity]), [[built, "Built1", "built", 1]]);

    assert.equal((await call("PATCH", `/api/decks/${idea}`, { status: "bogus" })).status, 400);
    r = await call("GET", `/api/decks/${idea}/status-preview?status=built`);
    assert.deepEqual([r.status, r.body.from, r.body.to, r.body.in_use_count, r.body.in_use.map((i) => i.name)], [200, "idea", "built", 1, ["Sol Ring"]]);
    assert.equal((await call("GET", `/api/decks/${idea}/status-preview?status=done`)).status, 400);
    assert.equal((await call("GET", "/api/decks/999/status-preview?status=built")).status, 404);
    r = await call("PATCH", `/api/decks/${idea}`, { status: "built" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "built");
    assert.deepEqual([r.body.status_change.from, r.body.status_change.to, r.body.status_change.in_use_count, r.body.status_change.conflict_count],
      ["idea", "built", 1, 1]);
    assert.equal(r.body.status_change.in_use[0].decks[0].name, "Built1");
    assert.equal((await call("PATCH", `/api/decks/${idea}`, { status: "built" })).body.status_change, undefined, "no change, no status_change");
    r = await call("GET", `/api/decks/${idea}/status-preview?status=built`);
    assert.equal(r.body.in_use_count, 0, "already built");
    d = (await call("GET", `/api/decks/${idea}`)).body;
    assert.equal(d.conflict_count, 1);
    assert.deepEqual(d.conflicts.map((c) => [c.name, c.owned, c.demand, c.decks.length]), [["Sol Ring", 1, 2, 2]]);
    assert.deepEqual(d.shopping.items, [], "contested but owned: not to buy for the deck");
    assert.deepEqual(d.shopping.in_use.map((i) => [i.name, i.quantity, i.conflict, i.price_eur]), [["Sol Ring", 1, true, 1.5]]);
    list = (await call("GET", "/api/decks")).body;
    assert.ok(list.every((x) => x.conflict_count === 1));

    r = await call("GET", "/api/shopping-list");
    assert.deepEqual(r.body.built.items.map((i) => [i.name, i.short, i.decks.length]), [["Sol Ring", 1, 2]]);
    assert.equal(r.body.built.total_eur, 1.5);
    assert.deepEqual(r.body.per_deck.map((x) => [x.name, x.status, x.missing_count, x.to_buy_count, x.in_use_count]),
      [["Built1", "built", 0, 0, 1], ["Idea1", "built", 0, 0, 1]]);

    r = await call("GET", `/api/cards/${ID.sol}`);
    assert.deepEqual([r.body.usage.owned, r.body.usage.built_demand, r.body.usage.available], [1, 2, -1]);
    assert.equal(r.body.usage.decks.length, 2);
    assert.ok(r.body.decks.every((x) => x.status === "built"));

    // Serra Angel is a ManaBox copy: moving it needs the master confirmation.
    r = await call("POST", `/api/decks/${built}/to-binder`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "confirm_master");
    r = await call("POST", `/api/decks/${built}/to-binder`, { confirm_master: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.binder, "Deck box: Built1");
    // Both built decks claim the one Sol Ring: the first deck boxed gets it, Idea1's box then can't.
    assert.deepEqual(r.body.moved.map((m) => [m.name, m.quantity]), [["Sol Ring", 1], ["Serra Angel", 1]]);
    assert.deepEqual(r.body.missing, []);
    assert.equal(r.body.deck.id, built);
    assert.equal(r.body.collection_master, "app");
    assert.equal((await call("POST", "/api/decks/999/to-binder", {})).status, 404);
    assert.equal((await call("POST", `/api/decks/${built}/to-binder`, { binder: 5 })).status, 400);
    r = await call("POST", `/api/decks/${idea}/to-binder`, {});
    assert.deepEqual([r.status, r.body.moved_copies, r.body.created], [200, 0, false]);
    assert.deepEqual(r.body.missing, [{ name: "Sol Ring", quantity: 1 }], "never taken out of another built deck's box");

    // Master app: the import default is delta; unknown modes are refused.
    assert.equal((await call("POST", "/api/import/manabox?mode=merge", undefined, { "Content-Type": "text/csv" })).status, 400);
  });
});
