// lib/spellbook.js: the Commander Spellbook client (v0.7.0 §6). Offline: a
// stub fetch answers from responses recorded live on 2026-10-15
// (test/fixtures/spellbook-estimate-*.json, trimmed). Covers the names-only
// payload, the cache key, trimResult on the real nested shape, the recorded
// multi-face behaviour, backoff/stale serving, the shared settings and the
// cross-connection slot reservation.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, getAppMeta } from "../lib/db.js";
import { tempDb } from "./fixtures.js";
import {
  SPACING_MS, BACKOFF_ERROR_MS, SPELLBOOK_DEFAULT_URL, cacheKey, cachedCombos, createSpellbookScheduler,
  deckPayloadRows, normName, pruneSpellbookCache, refreshCombos, reserveSlot, seedSpellbookSettings,
  setSpellbookSettings, spellbookHealth, spellbookOptedOut, spellbookRequest, spellbookSettings, tagToBracket, trimResult,
} from "../lib/spellbook.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/spellbook-estimate-${name}.json`, import.meta.url), "utf8"));
const FULL = fixture("full");
const FRONT = fixture("front");
const NOCMD = fixture("nocmd");

// Plan §2 column list; migration v9 creates it (no-op once that has run).
const CACHE_DDL = `CREATE TABLE IF NOT EXISTS spellbook_cache (key TEXT PRIMARY KEY, fetched_at TEXT, last_used_at TEXT,
  status TEXT, error TEXT, tag_raw TEXT, parser INTEGER, result TEXT)`;

const T0 = Date.parse("2026-10-15T12:00:00Z");

/** Stub fetch: records every call; `answer(call)` returns {status, json, headers} or throws. */
function stubFetch(answer = () => ({ status: 200, json: FULL.response })) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    const a = await answer(call);
    const headers = new Headers(a.headers ?? {});
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers });
  };
  fn.calls = calls;
  return fn;
}

const rowsOf = (list) => list.map(([board, name, quantity = 1, extra = {}]) => ({ board, name, quantity, scryfall_id: null, ...extra }));

let t;
let clock;
beforeEach(() => {
  t = tempDb();
  t.db.exec(CACHE_DDL);
  clock = T0;
});
afterEach(() => t.cleanup());
const ctxOf = (extra = {}) => ({ db: t.db, env: {}, now: () => clock, version: "0.7.0-test", ...extra });

describe("request (names only)", () => {
  test("only {card, quantity} entries leave the process; resolved rows send cards.name; side/maybe/companion stay home", async () => {
    const rows = rowsOf([
      ["commander", "Kenrith", 1, { scryfall_id: "sid-k", card_name: "Kenrith, the Returned King", oracle_id: "o-k", prices: "{}", binder: "secret" }],
      ["main", "Feuer // Eis", 1, { scryfall_id: "sid-f", card_name: "Fire // Ice", language: "de" }],
      ["main", "Sol Ring", 1, { scryfall_id: "sid-s1", card_name: "Sol Ring" }],
      ["main", "sol ring", 1, { scryfall_id: "sid-s2", card_name: "Sol Ring" }],
      ["main", "Notacard Xyz", 2],
      ["side", "Lurrus of the Dream-Den", 1, { companion: 1 }],
      ["main", "Lurrus of the Dream-Den", 1, { companion: 1 }],
      ["maybe", "Armageddon"],
      ["side", "Time Warp"],
    ]);
    const req = spellbookRequest(rows, { isCommander: true });
    assert.deepEqual(req.body, {
      commanders: [{ card: "Kenrith, the Returned King", quantity: 1 }],
      main: [{ card: "Fire // Ice", quantity: 1 }, { card: "Sol Ring", quantity: 2 }, { card: "Notacard Xyz", quantity: 2 }],
    });
    assert.equal(req.unknownCommanders, false);
    const fetch = stubFetch();
    const res = await refreshCombos(ctxOf({ fetch }), req);
    assert.equal(res.status, "ok");
    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, SPELLBOOK_DEFAULT_URL);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(Object.keys(call.init.headers).sort(), ["Accept", "Content-Type", "User-Agent"]);
    assert.match(call.init.headers["User-Agent"], /^mtg-planner\/0\.7\.0-test \(\+https:\/\/github\.com\/klopfer-hello\/mtg-planner\)$/);
    assert.deepEqual(Object.keys(call.body).sort(), ["commanders", "main"]);
    for (const e of [...call.body.commanders, ...call.body.main]) assert.deepEqual(Object.keys(e).sort(), ["card", "quantity"]);
    const sent = JSON.stringify(call.body);
    for (const leak of ["secret", "sid-", "o-k", "Feuer", "Lurrus", "Armageddon", "Time Warp", "de"]) assert.ok(!sent.includes(`"${leak}`) && !sent.includes(leak + '"'), leak);
  });

  test("no commander → ?unknownCommanders=true; non-commander decks are never sent", async () => {
    const req = spellbookRequest(rowsOf(NOCMD.request.body.main.map((e) => ["main", e.card])), { isCommander: true });
    assert.equal(req.unknownCommanders, true);
    const fetch = stubFetch(() => ({ json: NOCMD.response }));
    await refreshCombos(ctxOf({ fetch }), req);
    assert.equal(fetch.calls[0].url, `${SPELLBOOK_DEFAULT_URL}${NOCMD.request.query}`);
    assert.deepEqual(fetch.calls[0].body, NOCMD.request.body);

    assert.equal(spellbookRequest(rowsOf([["main", "Sol Ring", 4]]), { isCommander: false }), null);
    const res = await refreshCombos(ctxOf({ fetch }), null);
    assert.equal(res.reason, "not_commander");
    assert.equal(fetch.calls.length, 1);
  });

  test("schema caps: 12 commanders, 600 main entries", () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => ["commander", `C${i}`]),
      ...Array.from({ length: 610 }, (_, i) => ["main", `M${i}`]),
    ];
    const req = spellbookRequest(rowsOf(rows), { isCommander: true });
    assert.equal(req.body.commanders.length, 12);
    assert.equal(req.body.main.length, 600);
    assert.equal(req.truncated, true);
  });

  test("cache key is order-independent and ignores case/diacritics, not quantities", () => {
    const a = spellbookRequest(rowsOf([["commander", "Kenrith"], ["main", "Lim-Dûl's Vault"], ["main", "Sol Ring"]]), { isCommander: true });
    const b = spellbookRequest(rowsOf([["main", "sol ring"], ["main", "Lim-Dul's Vault"], ["commander", "KENRITH"]]), { isCommander: true });
    const c = spellbookRequest(rowsOf([["main", "Sol Ring", 2], ["main", "Lim-Dûl's Vault"], ["commander", "Kenrith"]]), { isCommander: true });
    const d = spellbookRequest(rowsOf([["main", "Kenrith"], ["main", "Lim-Dûl's Vault"], ["commander", "Sol Ring"]]), { isCommander: true });
    assert.equal(a.key, b.key);
    assert.notEqual(a.key, c.key);
    assert.notEqual(a.key, d.key, "board is part of the key");
    assert.equal(cacheKey(a.body), a.key);
  });

  test("deckPayloadRows: English cards.name for resolved rows, local front→full mapping for unresolved front faces", () => {
    const { db } = t;
    const card = db.prepare("INSERT INTO cards (scryfall_id, oracle_id, name, fetched_at) VALUES (?, ?, ?, ?)");
    card.run("sid-fi", "o-fi", "Fire // Ice", "2026-10-01");
    card.run("sid-de", "o-sr", "Sol Ring", "2026-10-01");
    const deckId = Number(db.prepare("INSERT INTO decks (name) VALUES ('X')").run().lastInsertRowid);
    const dc = db.prepare("INSERT INTO deck_cards (deck_id, board, name, scryfall_id, quantity) VALUES (?, ?, ?, ?, 1)");
    dc.run(deckId, "main", "Sonnenring", "sid-de");
    dc.run(deckId, "main", "Fire", null);
    dc.run(deckId, "main", "100% Unknown_", null);
    const rows = deckPayloadRows(db, deckId);
    const req = spellbookRequest(rows, { isCommander: true });
    assert.deepEqual(req.body.main.map((e) => e.card).sort(), ["100% Unknown_", "Fire // Ice", "Sol Ring"]);
  });
});

describe("trimResult (recorded response)", () => {
  test("maps the nested EstimateBracketResult", () => {
    const r = trimResult(FULL.response, FULL.request.body.commanders.concat(FULL.request.body.main).map((e) => e.card));
    assert.equal(r.tag, "R");
    assert.equal(tagToBracket(r.tag), 4);
    assert.deepEqual(r.gc.sort(), ["Rhystic Study", "Thassa's Oracle"]);
    assert.deepEqual(r.mld, ["Armageddon"]);
    assert.deepEqual(r.extra_turns, ["Time Warp"]);
    assert.deepEqual(r.banned, []);
    assert.equal(r.combos_total, 2);
    const [first, second] = r.combos;
    assert.equal(first.id, "742-1295", "definitely-two-card combo first");
    assert.deepEqual(first.cards.sort(), ["Demonic Consultation", "Thassa's Oracle"]);
    assert.ok(first.produces.includes("Win the game"));
    assert.equal(first.manaValueNeeded, 3);
    assert.equal(first.definitelyTwoCard, true);
    assert.equal(first.relevant, true);
    assert.equal(second.id, "4821-5261");
    assert.equal(second.manaValueNeeded, 0);
    assert.equal(second.arguablyTwoCard, true);
    assert.deepEqual(first.battlefield, [], "Thoracle + Consultation are cast from hand");
    assert.deepEqual(second.battlefield, ["Isochron Scepter"], "zoneLocations B: its cost is not in manaValueNeeded");
    assert.equal(second.definitelyTwoCard, false);
    for (const k of ["speed", "lock", "extraTurn", "massLandDenial", "skipTurns", "controlAllOpponents", "controlSomeOpponents", "borderlineRelevant"]) assert.ok(k in first, k);
    assert.deepEqual(r.unresolved, ["Notacard Xyz"], "unknown names are dropped silently by Spellbook");
    assert.ok(JSON.stringify(r).length < 10_000);
  });

  test("recorded multi-face behaviour: 'A // B' resolves, the front face alone does not", () => {
    const full = trimResult(FULL.response, FULL.request.body.main.map((e) => e.card));
    for (const n of ["Valakut Awakening // Valakut Stoneforge", "Fire // Ice", "Bonecrusher Giant // Stomp", "Akki Lavarunner // Tok-Tok, Volcano Born"]) {
      assert.ok(!full.unresolved.includes(n), n);
    }
    const front = trimResult(FRONT.response, FRONT.request.body.main.map((e) => e.card));
    assert.deepEqual(front.unresolved.sort(), ["Akki Lavarunner", "Bonecrusher Giant", "Fire", "Notacard Xyz", "Valakut Awakening"]);
  });

  test("unresolved diff is normalised (diacritics, case, front face)", () => {
    const raw = { bracketTag: "C", cards: [{ card: { name: "Lim-Dûl's Vault" } }, { card: { name: "Fire // Ice" } }, { card: { name: "Valakut Awakening // Valakut Stoneforge" } }], combos: [] };
    const r = trimResult(raw, ["Lim-Dul's Vault", "FIRE // ICE", "Valakut Awakening", "Lim-Dûl’s Vault", "Missing"]);
    assert.deepEqual(r.unresolved, ["Missing"]);
    assert.equal(normName("Lim-Dûl’s  Vault"), "lim-dul's vault");
  });

  test("defensive: unknown tag → null, junk fields → defaults", () => {
    assert.equal(trimResult({ bracketTag: "Z" }).tag, null);
    assert.equal(tagToBracket("Z"), null);
    assert.equal(tagToBracket("B"), "banned");
    assert.deepEqual([tagToBracket("S"), tagToBracket("P"), tagToBracket("O"), tagToBracket("C"), tagToBracket("E")], [3, 3, 2, 2, 1]);
    const r = trimResult({ cards: [null, { card: {} }, { card: { name: "X" }, gameChanger: "yes" }], combos: [{}, { combo: { id: 5, uses: [{ card: { name: "A" } }], manaValueNeeded: "4" } }] });
    assert.deepEqual(r.gc, []);
    assert.equal(r.combos.length, 1);
    assert.equal(r.combos[0].id, "5");
    assert.equal(r.combos[0].manaValueNeeded, null);
    assert.equal(r.combos[0].lock, false);
    assert.deepEqual(trimResult(null).combos, []);
  });
});

describe("cache, backoff and offline", () => {
  const req = () => spellbookRequest(rowsOf(FULL.request.body.main.map((e) => ["main", e.card])).concat(rowsOf([["commander", "Kenrith, the Returned King"]])), { isCommander: true });

  test("missing → pending; fetched → ok (no second call); past TTL → stale but served", async () => {
    const r = req();
    assert.equal(cachedCombos(t.db, r.key, { env: {}, now: clock }).status, "pending");
    const fetch = stubFetch();
    await refreshCombos(ctxOf({ fetch }), r);
    const ok = cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(ok.status, "ok");
    assert.equal(ok.result.tag, "R");
    assert.equal(t.db.prepare("SELECT tag_raw, parser, status FROM spellbook_cache").get().tag_raw, "R");
    await refreshCombos(ctxOf({ fetch }), r);
    assert.equal(fetch.calls.length, 1, "fresh entry is a cache hit");
    clock += 15 * 86400_000;
    const stale = cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(stale.status, "stale");
    assert.equal(stale.needs_fetch, true);
    assert.equal(stale.result.combos.length, 2);
  });

  test("429 honours Retry-After; the stale result survives the failure", async () => {
    const r = req();
    await refreshCombos(ctxOf({ fetch: stubFetch() }), r);
    clock += 15 * 86400_000;
    const fetch = stubFetch(() => ({ status: 429, headers: { "Retry-After": "30" }, text: "slow down" }));
    const res = await refreshCombos(ctxOf({ fetch }), r);
    assert.equal(res.reason, "error");
    assert.equal(res.status, "stale");
    assert.equal(res.result.tag, "R");
    assert.equal(Number(getAppMeta(t.db, "spellbook_backoff_until")), clock + 30_000);
    clock += 10_000;
    const blocked = await refreshCombos(ctxOf({ fetch }), r, { force: true });
    assert.equal(blocked.reason, "backoff");
    assert.equal(fetch.calls.length, 1, "no call during the backoff");
    clock += 25_000;
    await refreshCombos(ctxOf({ fetch: stubFetch() }), r);
    assert.equal(cachedCombos(t.db, r.key, { env: {}, now: clock }).status, "ok");
  });

  test("429 without Retry-After backs off 60 s", async () => {
    await refreshCombos(ctxOf({ fetch: stubFetch(() => ({ status: 429 })) }), req());
    assert.equal(Number(getAppMeta(t.db, "spellbook_backoff_until")), clock + 60_000);
  });

  test("5xx and timeout back off 5 min; nothing cached → offline with the error", async () => {
    const r = req();
    const res = await refreshCombos(ctxOf({ fetch: stubFetch(() => ({ status: 503 })) }), r);
    assert.equal(res.status, "offline");
    assert.match(res.error, /503/);
    assert.equal(Number(getAppMeta(t.db, "spellbook_backoff_until")), clock + BACKOFF_ERROR_MS);
    const view = cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(view.status, "offline");
    assert.equal(view.needs_fetch, false);
    assert.equal(spellbookHealth(t.db, { env: {}, now: clock }).last_error.status, 503);

    clock += BACKOFF_ERROR_MS + 1;
    setSpellbookSettings(t.db, { timeout_ms: 1000 });
    const hang = stubFetch((call) => new Promise((_, reject) => call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason))));
    const started = Date.now();
    const timed = await refreshCombos(ctxOf({ fetch: hang }), r);
    assert.ok(Date.now() - started < 5000);
    assert.match(timed.error, /timed out after 1000 ms/);
    assert.equal(Number(getAppMeta(t.db, "spellbook_backoff_until")), clock + BACKOFF_ERROR_MS);
    const net = await refreshCombos(ctxOf({ fetch: async () => { throw new TypeError("fetch failed"); } }), req(), { force: true });
    assert.equal(net.reason, "backoff");
  });

  test("a write while restoring is skipped", async () => {
    let restoring = false;
    const fetch = stubFetch(() => { restoring = true; return { json: FULL.response }; });
    const res = await refreshCombos(ctxOf({ fetch, restoring: () => restoring }), req());
    assert.equal(res.status, "ok");
    assert.equal(res.written, false);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache").get().n, 0);
    const again = await refreshCombos(ctxOf({ fetch, restoring: () => true }), req());
    assert.equal(again.reason, "restoring");
    assert.equal(fetch.calls.length, 1);
  });

  test("writes go to the db current at write time", async () => {
    const other = tempDb();
    other.db.exec(CACHE_DDL);
    try {
      let cur = t.db;
      const fetch = stubFetch(() => { cur = other.db; return { json: FULL.response }; });
      await refreshCombos(ctxOf({ fetch, db: () => cur }), req());
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache").get().n, 0);
      assert.equal(other.db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache").get().n, 1);
    } finally {
      other.cleanup();
    }
  });

  test("prune drops entries unused for 60 days; reads refresh last_used_at", async () => {
    const r = req();
    await refreshCombos(ctxOf({ fetch: stubFetch() }), r);
    clock += 50 * 86400_000;
    cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(pruneSpellbookCache(t.db, { now: clock + 20 * 86400_000 }), 0);
    assert.equal(pruneSpellbookCache(t.db, { now: clock + 61 * 86400_000 }), 1);
  });

  test("the cache is capped (least recently used first), also by every write", async () => {
    const ins = t.db.prepare("INSERT INTO spellbook_cache (key, fetched_at, last_used_at, status, parser) VALUES (?, ?, ?, 'ok', 1)");
    for (let i = 0; i < 5; i++) ins.run(`k${i}`, new Date(clock - i * 1000).toISOString(), new Date(clock - i * 1000).toISOString());
    assert.equal(pruneSpellbookCache(t.db, { now: clock, maxRows: 3 }), 2);
    assert.deepEqual(t.db.prepare("SELECT key FROM spellbook_cache ORDER BY key").all().map((r) => r.key), ["k0", "k1", "k2"]);
    for (let i = 0; i < 1005; i++) ins.run(`x${i}`, new Date(clock - 5000).toISOString(), new Date(clock - 5000).toISOString());
    await refreshCombos(ctxOf({ fetch: stubFetch() }), req());
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM spellbook_cache").get().n, 1000);
    assert.ok(t.db.prepare("SELECT 1 FROM spellbook_cache WHERE key = ?").get(req().key), "the new entry stays");
  });

  test("a stale entry whose refetch fails without a backoff (4xx) is retried every 10 min, not on every read", async () => {
    const r = req();
    await refreshCombos(ctxOf({ fetch: stubFetch() }), r);
    clock += 15 * 86400_000;
    const bad = stubFetch(() => ({ status: 400, text: "schema changed" }));
    for (let i = 0; i < 5; i++) {
      const res = await refreshCombos(ctxOf({ fetch: bad }), r);
      assert.equal(res.status, "stale");
      assert.equal(res.result.tag, "R", "the old result is still served");
      clock += 2000;
    }
    assert.equal(bad.calls.length, 1, "one call, then the error is remembered");
    const view = cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(view.needs_fetch, false);
    assert.ok(view.retry_at > clock);
    const sched = createSpellbookScheduler({ db: t.db, env: {}, now: () => clock, fetch: bad });
    try { await sched.ensure(r); } finally { sched.close(); }
    assert.equal(bad.calls.length, 1, "the scheduler obeys it too");
    clock += 10 * 60_000 + 1;
    assert.equal(cachedCombos(t.db, r.key, { env: {}, now: clock }).needs_fetch, true);
    await refreshCombos(ctxOf({ fetch: stubFetch() }), r);
    const fresh = cachedCombos(t.db, r.key, { env: {}, now: clock });
    assert.equal(fresh.status, "ok");
    assert.equal(t.db.prepare("SELECT error FROM spellbook_cache WHERE key = ?").get(r.key).error, null, "a success clears the note");
  });

  test("health counts cached results only (not error rows) and returns last_error as {at, status, message}", async () => {
    await refreshCombos(ctxOf({ fetch: async () => { throw new TypeError("fetch failed"); } }), req());
    const h = spellbookHealth(t.db, { env: {}, now: clock });
    assert.equal(h.cache_entries, 0);
    assert.equal(h.last_error.status, 0);
    assert.match(h.last_error.message, /fetch failed/);
  });
});

describe("settings and the shared slot", () => {
  const req = () => spellbookRequest(rowsOf([["commander", "Kenrith, the Returned King"], ["main", "Sol Ring"]]), { isCommander: true });

  test("disabled in meta, or SPELLBOOK_ENABLED=false in the (MCP) env → no fetch", async () => {
    const fetch = stubFetch();
    setSpellbookSettings(t.db, { enabled: false });
    assert.equal((await refreshCombos(ctxOf({ fetch }), req())).status, "disabled");
    assert.equal(cachedCombos(t.db, req().key, { env: {} }).status, "disabled");
    setSpellbookSettings(t.db, { enabled: true });
    const mcpEnv = { SPELLBOOK_ENABLED: "false" };
    assert.equal((await refreshCombos(ctxOf({ fetch, env: mcpEnv }), req())).status, "disabled");
    assert.equal(fetch.calls.length, 0);
    assert.equal(spellbookHealth(t.db, { env: mcpEnv }).enabled, false);
  });

  test("seed: env fills missing keys; SPELLBOOK_ENABLED=false always wins and reaches the other process via meta", async () => {
    setSpellbookSettings(t.db, { enabled: true, ttl_days: 7 });
    const s = seedSpellbookSettings(t.db, { SPELLBOOK_ENABLED: "false", SPELLBOOK_TTL_DAYS: "30", SPELLBOOK_TIMEOUT_MS: "nope" }, null);
    assert.equal(s.enabled, false);
    assert.equal(s.ttl_days, 7, "a stored value is kept");
    const mcp = openDb(t.file);
    try {
      const fetch = stubFetch();
      assert.equal(spellbookSettings(mcp, {}).enabled, false);
      assert.equal((await refreshCombos({ db: mcp, env: {}, now: () => clock, fetch }, req())).status, "disabled");
      assert.equal(fetch.calls.length, 0);
    } finally {
      mcp.close();
    }
    const fresh = tempDb();
    try {
      const f = seedSpellbookSettings(fresh.db, { SPELLBOOK_URL: "https://example.test/estimate-bracket", SPELLBOOK_TTL_DAYS: "3" }, null);
      assert.deepEqual([f.enabled, f.url, f.ttl_days, f.timeout_ms], [true, "https://example.test/estimate-bracket", 3, 10000]);
    } finally {
      fresh.cleanup();
    }
    assert.throws(() => setSpellbookSettings(t.db, { url: "ftp://x" }), /url/);
    // The URL is server-only: a stored one is replaced by SPELLBOOK_URL or the default at every seed.
    setSpellbookSettings(t.db, { url: "http://10.0.0.5:8123/x" });
    assert.equal(seedSpellbookSettings(t.db, {}, null).url, SPELLBOOK_DEFAULT_URL);
    setSpellbookSettings(t.db, { url: "http://10.0.0.5:8123/x" });
    assert.equal(seedSpellbookSettings(t.db, { SPELLBOOK_URL: "https://example.test/e" }, null).url, "https://example.test/e");
    assert.throws(() => setSpellbookSettings(t.db, { ttl_days: 0 }), /ttl_days/);
    assert.throws(() => setSpellbookSettings(t.db, { enabled: "yes" }), /enabled/);
  });

  test("seed keepOff (a restore): the opt-out survives a DB without the setting or with it on", () => {
    for (const stored of [null, { enabled: true }]) {
      const fresh = tempDb();
      try {
        if (stored) setSpellbookSettings(fresh.db, stored);
        assert.equal(spellbookOptedOut(fresh.db), false);
        assert.equal(seedSpellbookSettings(fresh.db, {}, null, { keepOff: true }).enabled, false);
        assert.equal(spellbookOptedOut(fresh.db), true);
      } finally {
        fresh.cleanup();
      }
    }
    setSpellbookSettings(t.db, { enabled: false });
    assert.equal(spellbookOptedOut(t.db), true);
    assert.equal(spellbookOptedOut(t.db), true, "env is ignored: it is the stored choice");
  });

  test("slot reservation across two connections allows one call per 1.5 s", () => {
    const other = openDb(t.file);
    try {
      assert.deepEqual(reserveSlot(t.db, { now: T0 }), { ok: true });
      const b = reserveSlot(other, { now: T0 + 100 });
      assert.equal(b.ok, false);
      assert.equal(b.reason, "spacing");
      assert.equal(b.retry_at, T0 + SPACING_MS);
      assert.equal(reserveSlot(t.db, { now: T0 + 1400 }).ok, false);
      assert.equal(reserveSlot(other, { now: T0 + SPACING_MS }).ok, true);
      assert.equal(reserveSlot(t.db, { now: T0 + SPACING_MS + 1 }).ok, false);
      t.db.exec("BEGIN");
      assert.equal(reserveSlot(t.db, { now: T0 + 10_000 }).reason, "busy", "never nests in a running transaction");
      t.db.exec("ROLLBACK");
    } finally {
      other.close();
    }
  });
});

describe("scheduler", () => {
  test("debounced per deck, one job per key, spaced calls, evaluate waits ≤ waitMs", async () => {
    const fetch = stubFetch();
    const requests = {
      1: spellbookRequest(rowsOf([["commander", "A"], ["main", "Sol Ring"]]), { isCommander: true }),
      2: spellbookRequest(rowsOf([["commander", "B"], ["main", "Sol Ring"]]), { isCommander: true }),
      3: null,
    };
    const sched = createSpellbookScheduler({ db: t.db, env: {}, fetch, delayMs: 20, requestFor: (_db, id) => requests[id] });
    try {
      sched.schedule(1); sched.schedule(1); sched.schedule(1);
      sched.schedule(2);
      sched.schedule(3);
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(sched.pending(), [requests[2].key], "deck 1 done, deck 2 waits for its slot");
      const [a, b] = await Promise.all([sched.ensure(requests[1]), sched.ensure(requests[2])]);
      assert.equal(a.status, "ok");
      assert.equal(b.status, "ok");
      assert.equal(fetch.calls.length, 2, "debounced and deduped");
      assert.equal(fetch.calls[0].body.commanders[0].card, "A");

      const slow = createSpellbookScheduler({ db: t.db, env: {}, fetch: stubFetch(() => new Promise((r) => setTimeout(() => r({ json: FULL.response }), 300))) });
      const r3 = spellbookRequest(rowsOf([["commander", "C"]]), { isCommander: true });
      const early = await slow.evaluate(r3, { waitMs: 30 });
      assert.equal(early.status, "pending");
      const done = await slow.ensure(r3);
      assert.equal(done.status, "ok");
      slow.close();
    } finally {
      sched.close();
    }
  });
});
