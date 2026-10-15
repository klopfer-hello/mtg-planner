// Recognition probes (v0.5.0 beta.2): ProbeRunner in lib/scans.js (outcomes,
// session memory, busy rule, counters, images only for staged probes) and
// the HTTP side of POST /api/scan {mode:'probe'} in server.js (validation,
// the unidentified answer, no Claude, no files, /healthz counters). Offline:
// the runner gets fake identify() results; the server test uses a
// one-printing index and a garbage JPEG that identify() cannot read.

import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { openDb } from "../lib/db.js";
import { openIndex, refreshIndex } from "../lib/cardindex.js";
import {
  PROBE_SESSION_RE, ProbeRunner, captureLog, createScanSlots, deleteScan, getScan, listScans, probeKey, stageScan, undoLast,
} from "../lib/scans.js";
import { ID, SCRYFALL_CARDS, seedCards, tempDb } from "./fixtures.js";

const fx = (id) => SCRYFALL_CARDS.find((c) => c.id === id);
const asPrinting = (c) => ({
  id: c.id, oracle_id: c.oracle_id, name: c.name, lang: c.lang, set_code: c.set, set_name: c.set_name,
  collector_number: c.collector_number, rarity: c.rarity, finishes: ["nonfoil", "foil"], faces: [],
});
const BOLT = asPrinting(fx(ID.lightning));
const SOL = asPrinting(fx(ID.sol));
const result = (printing, o = {}) => ({
  status: "auto", printing, store: printing, finish: "normal", finishSource: "star", method: "ocr", confidence: 0.9,
  candidates: [], variants: [], features: {}, timings: { total: 5 }, ...o,
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

describe("ProbeRunner", () => {
  let ctx, imageDir, runner, slots;
  const probe = (r, o = {}) => runner.run(ctx.db, async () => r, { session: "s1", image: JPEG, strip: JPEG, imageDir, ...o });
  beforeEach(() => {
    ctx = tempDb();
    seedCards(ctx.db);
    imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-probe-img-"));
    slots = createScanSlots(2);
    runner = new ProbeRunner({ slots });
  });
  afterEach(() => {
    ctx.cleanup();
    rmSync(imageDir, { recursive: true, force: true });
  });

  test("staged: identified + new card; stored with images, capture record and features.probe", async () => {
    const out = await probe(result(BOLT), { capture: { kind: "probe", d: 0.1, junk: "x" } });
    assert.equal(out.outcome, "staged");
    assert.equal(out.scan.store_printing_id, BOLT.id);
    assert.equal(out.scan.has_image, true);
    assert.equal(files(imageDir).length, 2);
    const full = getScan(ctx.db, out.scan.id, { features: true });
    assert.deepEqual(full.features.probe, { session: "s1" });
    assert.equal(full.features.capture.kind, "probe");
    assert.equal(full.features.capture.junk, undefined);
    assert.equal(slots.used, 0);
  });

  test("suggest stages too; review and failed are unidentified and leave nothing", async () => {
    assert.equal((await probe(result(BOLT, { status: "suggest" }))).outcome, "staged");
    const before = captureLog(ctx.db).dropped.length;
    for (const r of [result(SOL, { status: "review" }), result(null, { status: "failed", store: null }), null]) {
      const out = await probe(r, { capture: { kind: "probe" } });
      assert.equal(out.outcome, "unidentified");
      assert.equal(out.scan, null);
    }
    assert.equal(listScans(ctx.db).length, 1);
    assert.equal(files(imageDir).length, 2, "only the staged probe's images");
    assert.equal(captureLog(ctx.db).dropped.length, before, "no dropped-ring entries for unidentified probes");
    assert.equal(runner.stats().totals.unidentified, 3);
  });

  test("same card again: nothing stored, the last row untouched (no window refresh); the finish is not part of the key", async () => {
    const first = await probe(result(BOLT));
    const row = getScan(ctx.db, first.scan.id);
    const same = await probe(result(BOLT, { status: "suggest" }));
    assert.equal(same.outcome, "same");
    assert.equal(same.scan, null);
    assert.equal(listScans(ctx.db).length, 1);
    assert.equal(files(imageDir).length, 2);
    const after = getScan(ctx.db, first.scan.id);
    assert.equal(after.updated_at, row.updated_at);
    assert.equal(after.quantity, 1);
    // A different ★/• read of the same card is still 'same' (reads vary between probes).
    const foil = await probe(result(BOLT, { finish: "foil" }));
    assert.equal(foil.outcome, "same");
    assert.equal(foil.finish_upgraded, undefined, "a row whose finish was read (star) is never overwritten");
    assert.equal(getScan(ctx.db, first.scan.id).finish, "normal");
    assert.equal(listScans(ctx.db).length, 1);
  });

  test("finish voting: a confident ★ read upgrades a toggle-guessed row; never a user or single-finish row", async () => {
    const first = await probe(result(BOLT, { finishSource: "toggle" }));
    const before = getScan(ctx.db, first.scan.id);
    // no confident read: nothing changes
    const weak = await probe(result(BOLT, { finish: "foil", finishSource: "toggle" }));
    assert.equal(weak.outcome, "same");
    assert.equal(weak.scan, null);
    const up = await probe(result(BOLT, { finish: "foil", finishSource: "star" }));
    assert.equal(up.outcome, "same");
    assert.equal(up.finish_upgraded, true);
    assert.equal(up.scan.finish, "foil");
    assert.equal(up.scan.finish_source, "star");
    const after = getScan(ctx.db, first.scan.id);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.last_action, before.last_action);
    assert.equal(listScans(ctx.db).length, 1);
    // now read: a later dot read doesn't flip it back
    assert.equal((await probe(result(BOLT, { finish: "normal", finishSource: "star" }))).finish_upgraded, undefined);
    assert.equal(getScan(ctx.db, first.scan.id).finish, "foil");
    // a user-set finish is never touched
    ctx.db.prepare("UPDATE scans SET finish = 'normal', finish_source = 'user' WHERE id = ?").run(first.scan.id);
    assert.equal((await probe(result(BOLT, { finish: "foil", finishSource: "star" }))).finish_upgraded, undefined);
    assert.equal(getScan(ctx.db, first.scan.id).finish, "normal");
  });

  test("A, B, A: the second A is a new copy (only the last card counts); immediate, no duplicate window", async () => {
    assert.equal((await probe(result(BOLT))).outcome, "staged");
    assert.equal((await probe(result(SOL))).outcome, "staged");
    assert.equal((await probe(result(BOLT))).outcome, "staged");
    assert.equal(listScans(ctx.db).length, 3);
  });

  test("sessions are separate; no session compares against the newest staged scan", async () => {
    assert.equal((await probe(result(BOLT), { session: "a" })).outcome, "staged");
    assert.equal((await probe(result(SOL), { session: "b" })).outcome, "staged");
    assert.equal((await probe(result(BOLT), { session: "a" })).outcome, "same");
    assert.equal((await probe(result(SOL), { session: null })).outcome, "same", "newest staged is Sol Ring");
    assert.equal((await probe(result(BOLT), { session: null })).outcome, "staged");
  });

  test("Discard (delete) or undo of a probe-staged row never re-stages the card still in view", async () => {
    const a = await probe(result(BOLT));
    deleteScan(ctx.db, a.scan.id, { imageDir });
    assert.equal(files(imageDir).length, 0);
    assert.equal((await probe(result(BOLT))).outcome, "same");
    const b = await probe(result(SOL));
    assert.equal(b.outcome, "staged");
    const u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "delete");
    assert.equal(u.scan.id, b.scan.id);
    assert.equal(listScans(ctx.db).length, 0);
    assert.equal((await probe(result(SOL))).outcome, "same");
  });

  test("undo after a probe-staged row works like today: a +1 is taken back first", async () => {
    const a = await probe(result(BOLT));
    const { incrementScan } = await import("../lib/scans.js");
    incrementScan(ctx.db, a.scan.id);
    assert.equal(undoLast(ctx.db, { imageDir }).undone, "decrement");
    assert.equal(undoLast(ctx.db, { imageDir }).undone, "delete");
  });

  test("after a restart the session's last card comes from the database", async () => {
    await probe(result(BOLT));
    const fresh = new ProbeRunner({ slots });
    assert.equal((await fresh.run(ctx.db, async () => result(BOLT), { session: "s1", imageDir })).outcome, "same");
    assert.equal((await fresh.run(ctx.db, async () => result(SOL), { session: "s1", imageDir })).outcome, "staged");
  });

  test("a normal scan inside the session becomes its last card (noteScan)", async () => {
    const staged = stageScan(ctx.db, result(SOL), { imageDir });
    runner.noteScan("s1", result(SOL), staged.scan);
    assert.equal((await probe(result(SOL))).outcome, "same");
    runner.noteScan("s1", result(BOLT, { status: "review" }), staged.scan); // not identified: ignored
    assert.equal((await probe(result(SOL))).outcome, "same");
  });

  test("busy: slots full or the session's previous probe still running answer at once, identify not called", async () => {
    let release;
    const slow = runner.run(ctx.db, () => new Promise((r) => { release = r; }), { session: "s1", imageDir });
    let called = false;
    const again = await runner.run(ctx.db, async () => { called = true; return result(BOLT); }, { session: "s1", imageDir });
    assert.deepEqual([again.outcome, again.reason, called], ["busy", "session", false]);
    const other = runner.run(ctx.db, () => new Promise(() => {}), { session: "s2", imageDir }); // takes the 2nd slot
    const full = await runner.run(ctx.db, async () => { called = true; return result(BOLT); }, { session: "s3", imageDir });
    assert.deepEqual([full.outcome, full.reason, called], ["busy", "slots", false]);
    release(result(BOLT));
    assert.equal((await slow).outcome, "staged");
    assert.equal(slots.used, 1);
    void other;
    assert.equal(runner.stats().totals.busy, 2);
  });

  test("busy while the matcher warms up; errors are counted, rethrown and free the slot", async () => {
    const warm = new ProbeRunner({ slots, warming: () => true });
    const out = await warm.run(ctx.db, async () => assert.fail("must not identify"), { session: "s1" });
    assert.deepEqual([out.outcome, out.reason], ["busy", "warming_up"]);
    await assert.rejects(runner.run(ctx.db, async () => { throw new Error("boom"); }, { session: "s1" }), /boom/);
    assert.equal(slots.used, 0);
    assert.equal(runner.stats().totals.error, 1);
    assert.equal(runner.inFlight.size, 0);
  });

  test("a client that left during identify: nothing staged", async () => {
    const ac = new AbortController();
    const out = await runner.run(ctx.db, async () => { ac.abort(); return result(BOLT); }, { session: "s1", imageDir, signal: ac.signal });
    assert.equal(out.outcome, "cancelled");
    assert.equal(listScans(ctx.db).length, 0);
    assert.equal(files(imageDir).length, 0);
  });

  test("an upside-down card is stored with the upright re-encode", async () => {
    const up = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const out = await probe(result(BOLT, { upright: { card: up, strip: null } }));
    const stored = readdirSync(imageDir);
    assert.equal(out.outcome, "staged");
    assert.ok(stored.some((f) => f.endsWith("-strip.jpg")), "falls back to the sent strip");
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(readFileSync(path.join(imageDir, stored.find((f) => !f.endsWith("-strip.jpg")))), up);
  });

  test("per-minute counters keep the last 10 minutes", () => {
    let t = Date.parse("2026-10-14T10:00:30Z");
    const r = new ProbeRunner({ slots, now: () => t });
    r.count("staged");
    r.count("same");
    t += 60000;
    r.count("unidentified");
    t += 11 * 60000;
    r.count("busy");
    const s = r.stats();
    assert.deepEqual(s.totals, { staged: 1, same: 1, unidentified: 1, busy: 1, error: 0 });
    assert.equal(s.per_minute.length, 1);
    assert.equal(s.per_minute[0].busy, 1);
    assert.equal(s.per_minute[0].t, "2026-10-14T10:12:00.000Z");
  });

  test("probeKey and session ids", () => {
    assert.deepEqual(probeKey(result(BOLT, { finish: "nonfoil" })), { store_printing_id: BOLT.id, finish: "normal" });
    assert.equal(probeKey(result(null, { status: "failed", store: null })), null);
    assert.ok(PROBE_SESSION_RE.test("abc-123"));
    assert.ok(!PROBE_SESSION_RE.test("a b") && !PROBE_SESSION_RE.test("x".repeat(41)) && !PROBE_SESSION_RE.test(""));
  });
});

// ---------------------------------------------------------------------------
// HTTP: POST /api/scan {mode:'probe'} on a real server

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let dir, proc, base, indexFile, scanDir;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});
// A JPEG header the size check accepts (SOF0 64x64); its data is garbage, so identify() fails cleanly.
function fakeJpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200, 0x55), Buffer.from([0xff, 0xd9])]).toString("base64");
}
async function call(method, p, json) {
  const init = { method, headers: {} };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
// Claude calls the server started (the vision cap's timestamps, persisted in the index meta).
function visionCalls() {
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'vision_calls'").get();
    return row ? JSON.parse(row.value).length : 0;
  } finally {
    db.close();
  }
}

describe("POST /api/scan mode probe", () => {
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-probe-api-"));
    const dbFile = path.join(dir, "app.db");
    scanDir = path.join(dir, "scans");
    const db = openDb(dbFile);
    seedCards(db);
    db.close();
    indexFile = path.join(dir, "index.db");
    const bulk = path.join(dir, "all.jsonl.gz");
    writeFileSync(bulk, gzipSync(JSON.stringify({
      object: "card", id: "idx-1", oracle_id: "o-1", name: "Index Card", lang: "en", set: "m15", collector_number: "1", games: ["paper"],
      finishes: ["nonfoil"], prices: { eur: "6.5" },
    })));
    const idx = openIndex(indexFile);
    await refreshIndex(idx, { source: bulk, setsSource: [{ code: "m15", name: "Magic 2015" }] });
    idx.close();

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: indexFile, STATIC_DIR: path.join(ROOT, "public"),
        SCAN_IMAGE_DIR: scanDir, DEBUG_SESSIONS_DIR: path.join(dir, "debug"), BACKUP_DIR: path.join(dir, "bk"), SCAN_MATCHER_WAIT_MS: "0",
        SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", APP_VERSION: "9.9.9-test",
        // Claude "configured": the CLI is node itself, which fails at once; a call still shows in the vision cap.
        CLAUDE_CODE_OAUTH_TOKEN: "test-token", CLAUDE_BIN: process.execPath, SCAN_CLAUDE_PER_HOUR: "60", CLAUDE_CLI_INSTALL: "false",
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
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGKILL");
      await exited;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("bad mode / probe_session are 400", async () => {
    const card = fakeJpeg();
    assert.equal((await call("POST", "/api/scan", { card, mode: "peek" })).status, 400);
    for (const probe_session of ["a b", "x".repeat(41), 5, "ä"]) {
      const r = await call("POST", "/api/scan", { card, mode: "probe", probe_session });
      assert.equal(r.status, 400, JSON.stringify(probe_session));
      assert.match(r.body.error, /probe_session/);
    }
    assert.equal((await call("POST", "/api/scan", { mode: "probe" })).status, 400, "card is required");
  });

  test("an unreadable photo: outcome unidentified, nothing staged, no files, no Claude call", async () => {
    const r = await call("POST", "/api/scan", {
      card: fakeJpeg(), strip: fakeJpeg(), mode: "probe", probe_session: "sess-1", allowClaude: true, capture: { kind: "probe", d: 0.2 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.probe, true);
    assert.equal(r.body.outcome, "unidentified");
    assert.equal(r.body.scan, undefined);
    assert.equal(r.body.result.status, "failed");
    assert.equal(r.body.result.name, undefined);
    assert.equal(files(scanDir).length, 0);
    assert.equal((await call("GET", "/api/scans")).body.scans.length, 0);
    assert.equal(visionCalls(), 0);
    assert.equal((await call("GET", "/api/scans/capture-log")).body.dropped.length, 0);
  });

  test("control: the same photo as a normal scan asks Claude (so the probe's 0 means something)", async () => {
    const r = await call("POST", "/api/scan", { card: fakeJpeg(), allowClaude: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.probe, undefined);
    assert.equal(visionCalls(), 1);
    const p = await call("POST", "/api/scan", { card: fakeJpeg(), mode: "probe" });
    assert.equal(p.body.outcome, "unidentified");
    assert.equal(visionCalls(), 1);
  });

  test("/healthz reports the probe counters", async () => {
    const h = await call("GET", "/healthz");
    const probes = h.body.scanner.probes;
    assert.ok(probes.totals.unidentified >= 2, JSON.stringify(probes));
    assert.equal(probes.totals.staged, 0);
    assert.ok(probes.per_minute.length >= 1);
    assert.equal(probes.in_flight, 0);
    // the UI's auto-ask for hard cards reads the vision cap here
    const vision = h.body.scanner.vision;
    assert.equal(vision.configured, true);
    assert.equal(vision.per_hour, 60);
    assert.ok(vision.remaining <= 59, JSON.stringify(vision));
  });
});
