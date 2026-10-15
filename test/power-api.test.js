// HTTP layer of the deck power features (server.js): stats/power/combos in
// GET /api/decks/:id, the list's bracket/score fields, PATCH bracket_declared,
// POST /api/decks/:id/combos, POST /api/decks/evaluate, the Spellbook settings
// in /api/settings and /healthz. Starts the real server against a seeded temp
// DB and a local stub of Commander Spellbook's estimate-bracket endpoint
// (SPELLBOOK_URL), so nothing leaves the machine; every card used is owned, so
// no request needs Scryfall.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.js";
import { ID, seedCards, seedCollection } from "./fixtures.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base, stub, stubUrl;
const calls = []; // {body, headers}
let stubMode = "ok"; // ok | 429

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

/** estimate-bracket answer: every sent name known; Sol Ring + Counterspell a fast 2-card win. */
function estimate(body) {
  const names = [...body.commanders, ...body.main].map((e) => e.card);
  const card = (name) => ({ id: 1, name, oracleId: `o-${name}`, spoiler: false, faces: 1, typeLine: "Card" });
  const has = (n) => names.includes(n);
  const combos = has("Sol Ring") && has("Counterspell") ? [{
    combo: {
      id: "1-2",
      uses: [{ card: card("Sol Ring"), quantity: 1 }, { card: card("Counterspell"), quantity: 1 }],
      produces: [{ feature: { id: 1, name: "Win the game" }, quantity: 1 }],
      manaValueNeeded: 3,
    },
    relevant: true, borderlineRelevant: false, definitelyTwoCard: true, arguablyTwoCard: true, speed: 3,
    massLandDenial: false, extraTurn: false, lock: false, skipTurns: false, controlAllOpponents: false, controlSomeOpponents: false,
  }] : [];
  return {
    bracketTag: "S",
    cards: names.map((n) => ({ card: card(n), quantity: 1, banned: false, gameChanger: false, massLandDenial: false, extraTurn: false })),
    combos,
  };
}

before(async () => {
  stub = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      calls.push({ body, headers: req.headers, url: req.url });
      if (stubMode === "429") {
        res.writeHead(429, { "Retry-After": "120", "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(estimate(body)));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${stub.address().port}/estimate-bracket`;

  dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-power-api-"));
  const dbFile = path.join(dir, "app.db");
  const db = openDb(dbFile);
  seedCards(db);
  seedCollection(db, [[ID.sol, 2], [ID.atraxa, 1], [ID.counterspell, 2], [ID.serra, 1], [ID.lightning, 4], [ID.forest, 40]]);
  db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
      SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", CLAUDE_CODE_OAUTH_TOKEN: "", SPELLBOOK_URL: stubUrl, SPELLBOOK_ENABLED: "",
      APP_VERSION: "0.0.0-test",
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
  await new Promise((r) => stub?.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const COMMANDER_LIST = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Counterspell\n1 Serra Angel\n30 Forest\n";

describe("deck power API", () => {
  let cmdId, modernId;

  test("a commander deck gets stats, a bracket and a score; the combos are fetched in the background", async () => {
    const r = await call("POST", "/api/decks", { name: "Atraxa", format: "commander", text: COMMANDER_LIST });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cmdId = r.body.id;
    const first = await call("GET", `/api/decks/${cmdId}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.stats.total, 34);
    assert.equal(first.body.power.commander, true);
    assert.ok(first.body.power.bracket && first.body.power.score);
    assert.ok(["pending", "ok"].includes(first.body.combos.status));
    assert.equal(first.body.spellbook_request, undefined, "the request is not in the JSON");

    const done = await waitFor(async () => {
      const d = (await call("GET", `/api/decks/${cmdId}`)).body;
      return d.combos.status === "ok" ? d : null;
    });
    assert.equal(done.combos.items.length, 1);
    assert.equal(done.combos.items[0].url, "https://commanderspellbook.com/combo/1-2/");
    assert.equal(done.power.bracket.auto, 4, "fast 2-card combo → bracket 4");
    assert.equal(done.power.bracket.partial, false);
    assert.ok(done.power.bracket.reasons.some((x) => x.rule === "combo" && /Sol Ring \+ Counterspell/.test(x.text)));
    assert.ok(done.power.score.breakdown.find((b) => b.key === "combos").points > 0);

    // Only names and quantities left the process, with the app's User-Agent; once per deck.
    const sent = calls.filter((c) => c.body.commanders?.some((e) => e.card === "Atraxa, Praetors' Voice"));
    assert.equal(sent.length, 1, "one call for the deck, then cache hits");
    assert.deepEqual(Object.keys(sent[0].body).sort(), ["commanders", "main"]);
    for (const e of [...sent[0].body.commanders, ...sent[0].body.main]) assert.deepEqual(Object.keys(e).sort(), ["card", "quantity"]);
    assert.match(sent[0].headers["user-agent"], /^mtg-planner\/0\.0\.0-test \(\+https:\/\/github\.com\/klopfer-hello\/mtg-planner\)$/);
    assert.equal(sent[0].url, "/estimate-bracket");
    await call("GET", `/api/decks/${cmdId}`);
    assert.equal(calls.filter((c) => c.body.commanders?.some((e) => e.card === "Atraxa, Praetors' Voice")).length, 1);
  });

  test("a non-commander deck gets stats only and is never sent", async () => {
    const before = calls.length;
    const r = await call("POST", "/api/decks", { name: "Burn", format: "modern", text: "4 Lightning Bolt\n" });
    modernId = r.body.id;
    const d = (await call("GET", `/api/decks/${modernId}`)).body;
    assert.equal(d.stats.total, 4);
    assert.deepEqual(d.power, { commander: false, bracket: null, score: null, legality: null });
    assert.equal(d.combos, null);
    assert.equal((await call("POST", `/api/decks/${modernId}/combos`)).status, 400);
    await new Promise((res) => setTimeout(res, 3500)); // past the write debounce
    assert.equal(calls.length, before);
  });

  test("list rows carry bracket and score (null for non-commander decks)", async () => {
    const list = (await call("GET", "/api/decks")).body;
    const cmd = list.find((d) => d.id === cmdId);
    assert.equal(cmd.bracket, 4);
    assert.equal(cmd.bracket_partial, false);
    assert.equal(cmd.bracket_display, "4");
    assert.equal(typeof cmd.score, "number");
    assert.equal(cmd.score_partial, false);
    assert.equal(cmd.combos_status, "ok");
    const modern = list.find((d) => d.id === modernId);
    assert.equal(modern.bracket, null);
    assert.equal(modern.score, null);
  });

  test("PATCH bracket_declared: 1-5 or null, anything else 400", async () => {
    let r = await call("PATCH", `/api/decks/${cmdId}`, { bracket_declared: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.bracket_declared, 2);
    let d = (await call("GET", `/api/decks/${cmdId}`)).body;
    assert.equal(d.power.bracket.value, 2);
    assert.equal(d.power.bracket.declared, 2);
    assert.ok(d.power.bracket.reasons.some((x) => x.rule === "declared_below" && x.level === "warn"));
    for (const bad of [0, 6, 2.5, "3", true]) {
      assert.equal((await call("PATCH", `/api/decks/${cmdId}`, { bracket_declared: bad })).status, 400, `rejects ${JSON.stringify(bad)}`);
    }
    r = await call("PATCH", `/api/decks/${cmdId}`, { bracket_declared: null });
    assert.equal(r.body.bracket_declared, null);
    d = (await call("GET", `/api/decks/${cmdId}`)).body;
    assert.equal(d.power.bracket.value, 4);
  });

  test("POST /api/decks/evaluate: a dry run with a verdict, no deck row", async () => {
    const decks = (await call("GET", "/api/decks")).body.length;
    const r = await call("POST", "/api/decks/evaluate", {
      text: "1 Sol Ring\n1 Counterspell\n1 Atraxa, Praetors' Voice\n20 Forest", commander: "Atraxa, Praetors' Voice", target_bracket: 3,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.power.commander, true);
    assert.equal(r.body.combos.status, "ok");
    assert.equal(r.body.power.bracket.auto, 4);
    assert.match(r.body.verdict, /^Target bracket 3: OVER - .*Sol Ring \+ Counterspell/);
    assert.equal(r.body.stats.curve.commander[0].name, "Atraxa, Praetors' Voice");
    assert.equal((await call("GET", "/api/decks")).body.length, decks, "nothing saved");
    assert.equal((await call("POST", "/api/decks/evaluate", { text: "" })).status, 400);
    assert.equal((await call("POST", "/api/decks/evaluate", { text: "1 Sol Ring", target_bracket: 9 })).status, 400);
    const modern = await call("POST", "/api/decks/evaluate", { text: "4 Lightning Bolt", format: "modern" });
    assert.equal(modern.body.power.bracket, null);
    assert.equal(modern.body.combos, null);
  });

  test("/healthz reports Spellbook; /api/settings toggles it (off = no fetch, 503 on refresh)", async () => {
    const h = (await call("GET", "/healthz")).body;
    assert.equal(h.spellbook.enabled, true);
    assert.ok(h.spellbook.cache_entries >= 1);
    assert.ok(h.spellbook.last_ok);
    assert.equal(h.card_facts, null, "backfill not run with the scheduler off");

    let s = (await call("GET", "/api/settings")).body;
    assert.equal(s.spellbook_enabled, true);
    assert.equal(s.spellbook.url, stubUrl);
    assert.equal((await call("PATCH", "/api/settings", { spellbook_enabled: "no" })).status, 400);
    assert.equal((await call("PATCH", "/api/settings", { spellbook_url: "ftp://x" })).status, 400);
    // The target of the card names is server-only (SPELLBOOK_URL): no LAN request can redirect it.
    const moved = await call("PATCH", "/api/settings", { spellbook_url: "https://elsewhere.example/estimate-bracket" });
    assert.equal(moved.status, 400);
    assert.match(moved.body.error, /SPELLBOOK_URL/);
    assert.equal((await call("GET", "/api/settings")).body.spellbook.url, stubUrl);
    s = (await call("PATCH", "/api/settings", { spellbook_enabled: false })).body;
    assert.equal(s.spellbook_enabled, false);
    const before = calls.length;
    const d = (await call("GET", `/api/decks/${cmdId}`)).body;
    assert.equal(d.combos.status, "disabled");
    assert.equal(d.power.bracket.partial, true, "≥ while combos are off");
    assert.equal((await call("POST", `/api/decks/${cmdId}/combos`)).status, 503);
    const ev = await call("POST", "/api/decks/evaluate", { text: "1 Sol Ring\n1 Serra Angel", commander: "Atraxa, Praetors' Voice" });
    assert.equal(ev.body.combos.status, "disabled");
    assert.equal(calls.length, before, "no call while disabled");
    s = (await call("PATCH", "/api/settings", { spellbook_enabled: true })).body;
    assert.equal(s.spellbook_enabled, true);
  });

  test("POST /api/decks/:id/combos refetches (202), then 409 with retry_at during a backoff", async () => {
    assert.equal((await call("POST", "/api/decks/999/combos")).status, 404);
    stubMode = "429";
    const before = calls.length;
    const r = await call("POST", `/api/decks/${cmdId}/combos`);
    assert.equal(r.status, 202);
    await waitFor(async () => calls.length > before);
    const h = await waitFor(async () => {
      const b = (await call("GET", "/healthz")).body;
      return b.spellbook.backoff_until ? b : null;
    });
    assert.ok(Date.parse(h.spellbook.backoff_until) > Date.now() + 60_000);
    const again = await call("POST", `/api/decks/${cmdId}/combos`);
    assert.equal(again.status, 409);
    assert.ok(again.body.retry_at);
    // The good result stays served while backing off.
    const d = (await call("GET", `/api/decks/${cmdId}`)).body;
    assert.equal(d.combos.checked, true);
    assert.equal(d.power.bracket.auto, 4);
    stubMode = "ok";
  });
});

// The v9 card-facts backfill (lib/manabox.js backfillCardFacts) runs in the background after
// boot when the scheduler is on: Scryfall is stubbed in the server process (preloaded fetch).
describe("v9 card facts backfill after boot", () => {
  let proc2, base2, dir2, dbFile2;
  const FIX = new URL("./fixtures.js", import.meta.url).href;
  const PRELOAD = `--import=data:text/javascript,${encodeURIComponent(`
const { SCRYFALL_CARDS } = await import(${JSON.stringify(FIX)});
const real = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (new URL(String(url)).hostname !== "api.scryfall.com") return real(url, init);
  const { identifiers } = JSON.parse(init.body);
  const flag = { "Sol Ring": false, "Counterspell": true };
  const data = SCRYFALL_CARDS.filter((c) => identifiers.some((i) => i.id === c.id)).map((c) => ({ ...c, game_changer: flag[c.name] }));
  return new Response(JSON.stringify({ object: "list", data, not_found: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
};`)}`;

  before(async () => {
    dir2 = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-power-api-bf-"));
    dbFile2 = path.join(dir2, "app.db");
    const db = openDb(dbFile2);
    seedCards(db);
    seedCollection(db, [[ID.sol, 1], [ID.counterspell, 1], [ID.serra, 1]]);
    db.close();
    const port = await freePort();
    base2 = `http://127.0.0.1:${port}`;
    proc2 = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", PRELOAD, "server.js"], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(port), DB_FILE: dbFile2, INDEX_DB_FILE: path.join(dir2, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
        SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "true", CARD_FACTS_DELAY_MS: "100", CLAUDE_CODE_OAUTH_TOKEN: "", SPELLBOOK_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc2.stdout.on("data", (d) => { log += d; });
    proc2.stderr.on("data", (d) => { log += d; });
    const deadline = Date.now() + 20000;
    for (;;) {
      try { if ((await fetch(`${base2}/healthz`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  after(async () => {
    if (proc2 && proc2.exitCode == null) await new Promise((r) => { proc2.once("exit", r); proc2.kill("SIGKILL"); });
    rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("fills game_changer for owned cards, reports it in /healthz; SPELLBOOK_ENABLED=false wins", async () => {
    const h = await waitFor(async () => {
      const b = (await (await fetch(`${base2}/healthz`)).json());
      return b.card_facts?.done_at ? b : null;
    });
    assert.equal(h.card_facts.refreshed, 3);
    assert.equal(h.card_facts.skipped, 1, "Serra Angel came back without a flag");
    assert.equal(h.spellbook.enabled, false);
    assert.equal(h.spellbook.env_disabled, true);
    const db = openDb(dbFile2);
    try {
      const gc = Object.fromEntries(db.prepare("SELECT name, game_changer FROM cards WHERE scryfall_id IN (?, ?, ?)").all(ID.sol, ID.counterspell, ID.serra).map((r) => [r.name, r.game_changer]));
      assert.deepEqual(gc, { "Sol Ring": 0, Counterspell: 1, "Serra Angel": null });
    } finally {
      db.close();
    }
    const s = await (await fetch(`${base2}/api/settings`)).json();
    assert.equal(s.spellbook_enabled, false);
    const on = await fetch(`${base2}/api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spellbook_enabled: true }) });
    assert.equal(on.status, 409, "the env opt-out can't be switched on in Settings");
  });
});
