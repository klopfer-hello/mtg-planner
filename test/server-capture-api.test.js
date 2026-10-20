// HTTP layer of the v0.5.0 scanner additions (server.js): POST /api/scan's
// capture / dup_of validation and price_eur, the /increment {capture} body,
// GET /api/scans/capture-log and the record-session routes
// (/api/debug/frames, /api/debug/sessions) and the perf beacon (/api/debug/perf). Real server on a free port,
// temp DB, a one-printing card index; offline.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "../lib/db.js";
import { openIndex, refreshIndex } from "../lib/cardindex.js";
import { stageScan } from "../lib/scans.js";
import { ID, SCRYFALL_CARDS, seedCards } from "./fixtures.js";
import { startServer } from "./helpers/server.js";

let srv, dir, base, call, debugDir, staged;

// A JPEG header the size check accepts (SOF0 64x64); its data is garbage, so identify() fails cleanly.
function fakeJpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200, 0x55), Buffer.from([0xff, 0xd9])]);
}
const smallJpeg = (n = 2000) => { const b = Buffer.alloc(n, 3); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };

before(async () => {
  srv = await startServer({
    name: "capture-api",
    env: { SCAN_MATCHER_WAIT_MS: "0", SCAN_CLAUDE_PER_HOUR: "0", APP_VERSION: "9.9.9-test" },
    seed: async (dbFile, dir) => {
      const db = openDb(dbFile);
      seedCards(db);
      const bolt = SCRYFALL_CARDS.find((c) => c.id === ID.lightning);
      const printing = { id: bolt.id, oracle_id: bolt.oracle_id, name: bolt.name, lang: "en", set_code: bolt.set, collector_number: bolt.collector_number, finishes: ["nonfoil", "foil"] };
      staged = stageScan(db, { status: "auto", printing, store: printing, finish: "normal", features: {} }, { imageDir: path.join(dir, "scans") }).scan;
      // A second staged card, priced only by the card index (not in the app's cards table).
      const indexed = { id: "idx-1", oracle_id: "o-1", name: "Index Card", lang: "en", set_code: "m15", collector_number: "1", finishes: ["nonfoil"] };
      stageScan(db, { status: "auto", printing: indexed, store: indexed, finish: "normal", features: {} }, { imageDir: path.join(dir, "scans"), force: true });
      db.close();

      // a one-printing index, so /api/scan gets past "index still being built"
      const indexFile = path.join(dir, "index.db");
      const bulk = path.join(dir, "all.jsonl.gz");
      writeFileSync(bulk, gzipSync(JSON.stringify({
        object: "card", id: "idx-1", oracle_id: "o-1", name: "Index Card", lang: "en", set: "m15", collector_number: "1", games: ["paper"],
        finishes: ["nonfoil"], prices: { eur: "6.5" },
      })));
      const idx = openIndex(indexFile);
      await refreshIndex(idx, { source: bulk, setsSource: [{ code: "m15", name: "Magic 2015" }] });
      idx.close();
    },
  });
  ({ dir, base, call } = srv);
  debugDir = path.join(dir, "debug-sessions");
});

after(() => srv?.stop());

describe("POST /api/scan capture fields", () => {
  test("bad capture / dup_of are 400 before anything runs", async () => {
    const card = fakeJpeg().toString("base64");
    assert.equal((await call("POST", "/api/scan", { card, capture: [1] })).status, 400);
    assert.equal((await call("POST", "/api/scan", { card, capture: "x" })).status, 400);
    assert.equal((await call("POST", "/api/scan", { card, dup_of: "abc" })).status, 400);
    assert.equal((await call("POST", "/api/scan", { card, dup_of: -2 })).status, 400);
    const bad = await call("POST", "/api/scan", { card, settings: { precise: "yes" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /precise/);
  });

  test("settings.precise true is accepted", async () => {
    const r = await call("POST", "/api/scan", { card: fakeJpeg().toString("base64"), allowClaude: false, settings: { precise: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("an unidentifiable photo: result carries price_eur null; its capture record reaches the log", async () => {
    const r = await call("POST", "/api/scan", {
      card: fakeJpeg().toString("base64"), allowClaude: false, capture: { kind: "new", d: 0.3, fallback: true, quad_source: "default", junk: "x" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.scan, null);
    assert.equal(r.body.result.status, "failed");
    assert.ok("price_eur" in r.body.result);
    assert.equal(r.body.result.price_eur, null);
    const log = await call("GET", "/api/scans/capture-log");
    const last = log.body.dropped.at(-1);
    assert.equal(last.reason, "failed");
    assert.equal(last.capture.quad_source, "default");
    assert.equal(last.capture.junk, undefined);
  });
});

describe("POST /api/scans/:id/increment", () => {
  test("without a body (old UI) and with {capture}; the event shows in features and the capture log", async () => {
    let r = await fetch(`${base}/api/scans/${staged.id}/increment`, { method: "POST" });
    assert.equal(r.status, 200);
    r = await call("POST", `/api/scans/${staged.id}/increment`, {});
    assert.equal(r.status, 200);
    r = await call("POST", `/api/scans/${staged.id}/increment`, { capture: { kind: "chip", d: 0.05, chip: { label: "same", d: 0.05 } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.quantity, 4);
    const f = (await call("GET", `/api/scans/${staged.id}?features=1`)).body.features;
    assert.deepEqual(f.capture_events.map((e) => [e.event, e.q, e.capture.chip.label]), [["increment", 4, "same"]]);
    const log = await call("GET", "/api/scans/capture-log");
    assert.equal(log.status, 200);
    assert.ok(log.body.scans.some((s) => s.id === staged.id && s.capture_events.length === 1));
  });

  test("a capture that is not an object is 400; an oversized body 413", async () => {
    assert.equal((await call("POST", `/api/scans/${staged.id}/increment`, { capture: [1, 2] })).status, 400);
    assert.equal((await call("POST", `/api/scans/${staged.id}/increment`, { capture: { pad: "x".repeat(20000) } })).status, 413);
    assert.equal((await call("POST", "/api/scans/99999/increment", {})).status, 404);
  });
});

describe("record session API", () => {
  test("frames and records are stored, listed and deleted", async () => {
    const jpeg = smallJpeg().toString("base64");
    assert.equal((await call("POST", "/api/debug/frames", { session: "rec-1", seq: 0, jpeg })).status, 204);
    assert.equal((await call("POST", "/api/debug/frames", { session: "rec-1", seq: 1, jpeg, record: { kind: "new", d: 0.2 } })).status, 204);
    assert.equal((await call("POST", "/api/debug/frames", { session: "rec-1", seq: 2, record: { kind: "silent" } })).status, 204);
    assert.deepEqual(readdirSync(path.join(debugDir, "rec-1")).sort(), ["0000000.jpg", "0000001.jpg", "records.jsonl", "session.json"]);
    const list = await call("GET", "/api/debug/sessions");
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    const s = list.body.sessions[0];
    assert.equal(s.id, "rec-1");
    assert.equal(s.frames, 2);
    assert.ok(s.bytes > 4000);
    assert.ok(Date.parse(s.started_at));
    assert.equal((await call("DELETE", "/api/debug/sessions/rec-1")).status, 204);
    assert.equal(existsSync(path.join(debugDir, "rec-1")), false);
    assert.equal((await call("DELETE", "/api/debug/sessions/rec-1")).status, 404);
    assert.deepEqual((await call("GET", "/api/debug/sessions")).body, { sessions: [] });
  });

  test("validation: session id, JPEG, frame size, missing payload", async () => {
    const jpeg = smallJpeg().toString("base64");
    assert.equal((await call("POST", "/api/debug/frames", { session: "../x", seq: 0, jpeg })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "a.b", seq: 0, jpeg })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "ok", seq: "0", jpeg })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "ok", seq: 0, jpeg: Buffer.from("hello world").toString("base64") })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "ok", seq: 0, jpeg: 5 })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "ok", seq: 0 })).status, 400);
    assert.equal((await call("POST", "/api/debug/frames", { session: "ok", seq: 0, jpeg: smallJpeg(301 * 1024).toString("base64") })).status, 413);
    assert.equal((await call("DELETE", "/api/debug/sessions/a.b")).status, 400);
    assert.equal((await call("GET", "/api/debug/nope")).status, 404);
    assert.equal(existsSync(path.join(debugDir, "ok")), false);
  });
});

describe("perf beacon API", () => {
  test("POST stores a validated beacon (204) in <db dir>/debug-perf.jsonl; GET lists newest first", async () => {
    const beacon = { session: "p1", ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9)", video: { w: 2160, h: 3840, fps: 30 }, analyze: { n: 30, p50: 41.2, p90: 80, max: 120 }, worker: true, junk: 1 };
    assert.equal((await call("POST", "/api/debug/perf", beacon)).status, 204);
    assert.equal((await call("POST", "/api/debug/perf", { ...beacon, gap: 250 })).status, 204);
    const lines = readFileSync(path.join(dir, "debug-perf.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].junk, undefined);
    assert.deepEqual(lines[0].video, { w: 2160, h: 3840, fps: 30 });
    const got = await call("GET", "/api/debug/perf?limit=1");
    assert.equal(got.status, 200);
    assert.equal(got.body.entries.length, 1);
    assert.equal(got.body.entries[0].gap, 250);
    assert.ok(Date.parse(got.body.entries[0].at));
  });

  test("400 for nothing known, 413 for an oversized body; the scan worker module is served as JavaScript", async () => {
    assert.equal((await call("POST", "/api/debug/perf", { nothing: 1 })).status, 400);
    assert.equal((await call("POST", "/api/debug/perf", { ua: "x".repeat(20000) })).status, 413);
    const res = await fetch(`${base}/scanworker.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    await res.arrayBuffer();
  });
});

describe("GET /api/scans prices", () => {
  test("rows carry price_eur (index, else the cards table); the staged list carries totals", async () => {
    const r = await call("GET", "/api/scans?status=staged");
    assert.equal(r.status, 200);
    const bolt = r.body.scans.find((x) => x.id === staged.id);
    const idxRow = r.body.scans.find((x) => x.store_printing_id === "idx-1");
    assert.equal(bolt.price_eur, 2); // not in the index: app cards table eur
    assert.equal(idxRow.price_eur, 6.5); // index EUR
    const copies = bolt.quantity + idxRow.quantity;
    assert.deepEqual(r.body.totals, {
      staged: { cards: 2, copies, value_eur: Math.round((bolt.quantity * 2 + idxRow.quantity * 6.5) * 100) / 100, unpriced: 0 },
    });
    const all = await call("GET", "/api/scans?status=all");
    assert.equal(all.status, 200);
    assert.equal(all.body.totals, undefined);
    assert.equal(all.body.scans.length, 2);
    assert.ok(all.body.scans.every((x) => typeof x.price_eur === "number"));
  });
});
