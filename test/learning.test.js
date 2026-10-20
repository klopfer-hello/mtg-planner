// Implicit confirmation of SUGGEST scans, labelled examples (lib/scans.js)
// and the learning report (lib/learning.js), plus the HTTP side
// (GET /api/scans/learning, /api/calibration/export?source=). Offline: fake
// identify() results, Scryfall's /cards/collection stubbed, a stub index.

import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.js";
import { ProbeRunner, createScanSlots, incrementScan, recordTruth, stageScan, undoLast, updateScan } from "../lib/scans.js";
import { commitScans } from "../lib/scancommit.js";
import { exportCalibration } from "../lib/scanlabels.js";
import { getScan, scanImagePath } from "../lib/scanrow.js";
import { DEFAULT_THRESHOLDS } from "../lib/scanner.js";
import { LEARNING_METRICS, blockersOf, evidenceOf, learningReport, relaxOf } from "../lib/learning.js";
import { ID, SCRYFALL_CARDS, seedCards, stubScryfall, tempDb } from "./fixtures.js";

const fx = (id) => SCRYFALL_CARDS.find((c) => c.id === id);
const asPrinting = (c, extra = {}) => ({
  id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: null, lang: c.lang, set_code: c.set, set_name: c.set_name,
  collector_number: c.collector_number, rarity: c.rarity, finishes: ["nonfoil", "foil"], faces: [], ...extra,
});
const BOLT = asPrinting(fx(ID.lightning));
const SOL = asPrinting(fx(ID.sol));
const SERRA = asPrinting(fx(ID.serra), { finishes: ["nonfoil"] });
const BOLT_DE = { ...BOLT, id: "aaaaaaaa-0000-0000-0000-000000000146", lang: "de", printed_name: "Blitzschlag" };
const PRINTINGS = [BOLT, SOL, SERRA, BOLT_DE];
const index = {
  getPrinting: (_i, id) => PRINTINGS.find((p) => p.id === id) ?? null,
  storagePrinting: (_i, p) => p,
};
const idx = {};
const T = DEFAULT_THRESHOLDS;

// A detection with the evidence the learning report reads.
const result = (printing, o = {}) => ({
  status: "auto", printing, store: printing, finish: "normal", finishSource: "toggle", method: "ocr", confidence: 0.8,
  candidates: [], variants: [], timings: { total: 5 },
  features: {
    collector: { raw: "x", confidence: o.line ?? 0.9 },
    fingerprint: { d1: o.d1 ?? 0.2, gap: o.gap ?? 0.1 },
    candidates: [{ id: printing.id, title: o.title ?? 0.9, fp: o.fp ?? 0.2 }],
    local: { status: o.status ?? "auto", reasons: o.reasons ?? [] },
  },
  ...o.r,
});
const suggest = (p, o = {}) => result(p, { status: "suggest", ...o, r: { status: "suggest", ...o.r } });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let ctx, imageDir, stub, runner;
const probe = (r, session = "s1") => runner.run(ctx.db, async () => r, { session, image: JPEG, strip: JPEG, imageDir });
const raw = (id) => ctx.db.prepare("SELECT * FROM scans WHERE id = ?").get(id);
const full = (id) => getScan(ctx.db, id, { features: true });
beforeEach(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-learn-img-"));
  stub = stubScryfall();
  runner = new ProbeRunner({ slots: createScanSlots(2) });
});
afterEach(() => {
  stub.restore();
  ctx.cleanup();
  rmSync(imageDir, { recursive: true, force: true });
});

describe("implicit confirmation", () => {
  test("the next card of the session confirms the SUGGEST row: label implicit, updated_at/last_action untouched", async () => {
    const a = (await probe(suggest(BOLT))).scan;
    assert.equal(a.match_status, "suggest");
    const before = raw(a.id);
    const b = await probe(result(SOL));
    assert.equal(b.outcome, "staged");
    assert.deepEqual(b.confirmed, [{ id: a.id, name: BOLT.name, printing_id: BOLT.id }]);
    const row = full(a.id);
    assert.equal(row.match_status, "confirmed");
    assert.equal(row.features.confirm.source, "implicit");
    assert.deepEqual(row.features.confirm.by, { scan: b.scan.id, created_at: b.scan.created_at, action: "stage" });
    assert.equal(row.calibration_truth.source, "implicit");
    assert.equal(row.calibration_truth.printing_id, BOLT.id);
    assert.equal(row.calibration_truth.detected_status, "suggest");
    assert.equal(row.calibration, false, "no calibration image retention");
    const after = raw(a.id);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.last_action, before.last_action);
    assert.equal(full(b.scan.id).features.session, "s1");
  });

  test("never: review rows, other sessions, edited rows, a new row of the same card, no session", async () => {
    const review = stageScan(ctx.db, result(SERRA, { r: { status: "review" } }), { imageDir, session: "s1" }).scan;
    const other = (await probe(suggest(SOL), "s2")).scan;
    const edited = (await probe(suggest(SERRA))).scan;
    updateScan(ctx.db, edited.id, { quantity: 2 }, { idx, index });
    const bolt = (await probe(suggest(BOLT))).scan;
    // the same card in another printing (a second probe of one physical card may resolve differently)
    const de = await probe(suggest(BOLT_DE));
    assert.equal(de.outcome, "staged");
    assert.deepEqual(de.confirmed, []);
    assert.equal(raw(bolt.id).match_status, "suggest");
    assert.equal(raw(review.id).match_status, "review");
    assert.equal(raw(other.id).match_status, "suggest");
    assert.equal(raw(edited.id).match_status, "suggest");
    // a scan without a session confirms nothing
    assert.deepEqual(stageScan(ctx.db, result(SOL), { imageDir, force: true }).confirmed, []);
    assert.equal(raw(bolt.id).match_status, "suggest");
    assert.equal(raw(de.scan.id).match_status, "suggest");
  });

  test("a shutter scan of the session confirms too; a duplicate answer does not", async () => {
    const a = (await probe(suggest(BOLT))).scan;
    const dup = stageScan(ctx.db, suggest(BOLT), { imageDir, session: "s1" });
    assert.equal(dup.duplicate, true);
    assert.equal(raw(a.id).match_status, "suggest");
    const shot = stageScan(ctx.db, result(SOL), { imageDir, session: "s1" });
    assert.deepEqual(shot.confirmed.map((c) => c.id), [a.id]);
    assert.equal(raw(a.id).match_status, "confirmed");
  });

  test("undo of the new card takes the implicit confirmation back", async () => {
    const a = (await probe(suggest(BOLT))).scan;
    const b = (await probe(result(SOL))).scan;
    const u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "delete");
    assert.equal(u.scan.id, b.id);
    assert.deepEqual(u.unconfirmed, [a.id]);
    const row = full(a.id);
    assert.equal(row.match_status, "suggest");
    assert.equal(row.calibration_truth, null);
    assert.equal(row.features.confirm, undefined);
  });

  test("a +1 on another row of the session confirms; undoing that +1 reverts it", async () => {
    const b = (await probe(result(SOL))).scan;
    const a = (await probe(suggest(BOLT))).scan;
    // same-ms actions on an older row: the action clock still orders them after the stage
    const inc = incrementScan(ctx.db, b.id);
    assert.equal(inc.quantity, 2);
    assert.deepEqual(inc.implicitly_confirmed.map((c) => c.id), [a.id]);
    assert.equal(raw(a.id).match_status, "confirmed");
    // nothing left to confirm
    const plain = incrementScan(ctx.db, b.id);
    assert.equal(plain.implicitly_confirmed, undefined);
    const u1 = undoLast(ctx.db, { imageDir });
    assert.equal(u1.undone, "decrement");
    assert.deepEqual(u1.unconfirmed, [], "the second +1 confirmed nothing");
    assert.equal(raw(a.id).match_status, "confirmed");
    const u2 = undoLast(ctx.db, { imageDir });
    assert.equal(u2.undone, "decrement");
    assert.deepEqual(u2.unconfirmed, [a.id]);
    assert.equal(raw(a.id).match_status, "suggest");
    const self = (await probe(suggest(SERRA))).scan;
    assert.equal(incrementScan(ctx.db, self.id).implicitly_confirmed, undefined);
  });

  test("undo follows the action order when the clock ties or steps back", () => {
    const T = Date.parse("2026-10-17T10:00:00Z");
    const a = stageScan(ctx.db, suggest(BOLT), { imageDir, session: "s1", now: T }).scan;
    const b = stageScan(ctx.db, result(SOL), { imageDir, session: "s1", now: T - 5000 }).scan; // clock stepped back
    assert.ok(b.created_at > a.created_at);
    assert.equal(raw(a.id).match_status, "confirmed");
    const u = undoLast(ctx.db, { imageDir });
    assert.deepEqual([u.undone, u.scan.id, u.unconfirmed], ["delete", b.id, [a.id]]);
    assert.equal(raw(a.id).match_status, "suggest");
    // a new row under the reused id gets a newer created_at than the removed one
    const c = stageScan(ctx.db, result(SOL), { imageDir, now: T - 60000 }).scan;
    assert.equal(c.id, b.id);
    assert.ok(c.created_at > b.created_at);
    // a +1 of the older row in the same ms, then an edit with an even earlier clock
    incrementScan(ctx.db, a.id, { now: T });
    updateScan(ctx.db, c.id, { condition: "played" }, { idx, index, now: T - 9000 });
    const order = [undoLast(ctx.db, { imageDir }), undoLast(ctx.db, { imageDir })];
    assert.deepEqual(order.map((x) => [x.undone, x.scan.id]), [["revert", c.id], ["decrement", a.id]]);
  });

  test("a user confirm/fix after the implicit one is kept by the undo; the label says so", async () => {
    const a = (await probe(suggest(BOLT))).scan;
    await probe(result(SOL));
    updateScan(ctx.db, a.id, { confirm: true }, { idx, index });
    let row = full(a.id);
    assert.equal(row.features.confirm.source, "user");
    assert.equal(row.features.confirm.after, "implicit");
    assert.equal(row.calibration_truth.source, "user");
    // undo reverts the user's edit first (back to the implicit confirmation) ...
    const u = undoLast(ctx.db, { imageDir });
    assert.equal(u.undone, "revert");
    row = full(a.id);
    assert.equal(row.match_status, "confirmed");
    assert.equal(row.features.confirm.source, "implicit");
    assert.equal(row.calibration_truth.source, "implicit");
  });
});

describe("labels", () => {
  test("Confirm = user, a picked other printing = correction; undo of the edit removes the label", async () => {
    const a = stageScan(ctx.db, suggest(BOLT), { imageDir }).scan;
    updateScan(ctx.db, a.id, { printing_id: BOLT.id }, { idx, index }); // the UI's Confirm
    assert.equal(full(a.id).calibration_truth.source, "user");
    assert.equal(undoLast(ctx.db, { imageDir }).undone, "revert");
    let row = full(a.id);
    assert.equal(row.match_status, "suggest");
    assert.equal(row.calibration_truth, null);
    assert.equal(row.features.confirm, undefined);
    updateScan(ctx.db, a.id, { printing_id: SOL.id }, { idx, index });
    row = full(a.id);
    assert.equal(row.calibration_truth.source, "correction");
    assert.equal(row.calibration_truth.printing_id, SOL.id);
    assert.equal(row.calibration_truth.detected_status, "suggest");
  });

  test("recordTruth = calibration (a confirmation never overwrites it)", () => {
    const a = stageScan(ctx.db, suggest(BOLT), { imageDir }).scan;
    recordTruth(ctx.db, a.id, { printing_id: SOL.id, finish: "foil" }, { idx, index });
    const row = full(a.id);
    assert.equal(row.calibration_truth.source, "calibration");
    assert.equal(row.calibration_truth.printing_id, SOL.id);
    assert.equal(row.calibration, true);
  });

  test("commit: untouched rows get a commit label, labels follow the final row; only calibration keeps images", async () => {
    const auto = stageScan(ctx.db, result(SERRA), { imageDir, image: JPEG, session: "s1" }).scan;
    const sug = stageScan(ctx.db, suggest(BOLT), { imageDir, image: JPEG, session: "s1" }).scan;
    stageScan(ctx.db, result(SOL), { imageDir, image: JPEG, session: "s1" }); // confirms sug
    updateScan(ctx.db, sug.id, { finish: "foil" }, { idx, index });
    const cal = stageScan(ctx.db, result(SOL, { r: { finish: "foil" } }), { imageDir, image: JPEG, calibration: true, force: true }).scan;
    recordTruth(ctx.db, cal.id, { printing_id: SOL.id }, { idx, index });
    const manual = stageScan(ctx.db, { ...result(SOL), status: "manual", features: { manual: true } }, { imageDir, force: true }).scan;
    await commitScans(ctx.db, [auto.id, sug.id, cal.id, manual.id], { type: "binder", name: "L", create: true }, { idx, index, imageDir });
    const a = full(auto.id).calibration_truth;
    assert.equal(a.source, "commit");
    assert.equal(a.printing_id, SERRA.id);
    assert.ok(a.committed_at);
    const s = full(sug.id).calibration_truth;
    assert.equal(s.source, "implicit");
    assert.equal(s.finish, "foil", "the final finish");
    assert.equal(full(cal.id).calibration_truth.source, "calibration");
    assert.equal(full(manual.id).calibration_truth, null, "manual rows were never detected");
    assert.equal(scanImagePath(ctx.db, auto.id, { imageDir }), null);
    assert.equal(scanImagePath(ctx.db, sug.id, { imageDir }), null);
    assert.ok(existsSync(scanImagePath(ctx.db, cal.id, { imageDir })));
    const all = exportCalibration(ctx.db);
    assert.deepEqual(all.map((e) => e.source).sort(), ["calibration", "commit", "implicit"]);
    assert.deepEqual(exportCalibration(ctx.db, { sources: ["implicit"] }).map((e) => e.id), [sug.id]);
    assert.equal(all.find((e) => e.id === sug.id).status, "committed");
  });
});

describe("learning report", () => {
  test("evidence, blockers and the safe relax", () => {
    const ev = evidenceOf(suggest(BOLT, { title: 0.7, line: 0.3, fp: 0.3, d1: 0.3, gap: 0.03 }).features, BOLT.id);
    assert.deepEqual(ev, { title: 0.7, fp: 0.3, d1: 0.3, gap: 0.03, collector: 0.3, line: true });
    assert.deepEqual(blockersOf(ev, ["competing card Sol Ring", "3 printings share this art"], T),
      ["titleAuto", "collectorConf", "fpVerify", "fpAuto", "fpGap", "competing card", "printings share this art"]);
    assert.deepEqual(blockersOf(evidenceOf({}, "x"), [], T), ["no title read", "no collector line", "no fingerprint"]);
    const title = LEARNING_METRICS.find((m) => m.key === "title");
    // confirmed at 0.72/0.7/0.6, a wrong one at 0.65: 0.75 → 0.7 is safe (2 more AUTO), 0.6 would pass the wrong one
    assert.deepEqual(relaxOf(title, 0.75, [0.72, 0.7, 0.6, 0.9], [0.65, 0.3]), { value: 0.7, gained: 2, wrong_passing: 0 });
    assert.equal(relaxOf(title, 0.75, [0.6], [0.7]), null);
    const fp = LEARNING_METRICS.find((m) => m.key === "fp");
    assert.deepEqual(relaxOf(fp, 0.26, [0.28, 0.3, 0.2], [0.35]), { value: 0.3, gained: 2, wrong_passing: 0 });
  });

  test("counts by source and outcome, the top reason, histograms", async () => {
    // 3 SUGGESTs the user scans past (title just below titleAuto), 1 corrected SUGGEST, 1 kept AUTO, 1 corrected AUTO
    for (const t of [0.7, 0.72, 0.71]) {
      await probe(suggest(BOLT, { title: t }));
      await probe(result(SERRA)); // confirms the SUGGEST; itself AUTO
    }
    const wrong = (await probe(suggest(SOL, { title: 0.66, reasons: ["competing card Lightning Bolt"] }))).scan;
    updateScan(ctx.db, wrong.id, { printing_id: SERRA.id }, { idx, index });
    const autoWrong = stageScan(ctx.db, result(BOLT, { title: 0.8 }), { imageDir, force: true }).scan;
    updateScan(ctx.db, autoWrong.id, { printing_id: SOL.id }, { idx, index });
    const autoOk = stageScan(ctx.db, result(SOL), { imageDir, force: true }).scan;
    updateScan(ctx.db, autoOk.id, { confirm: true }, { idx, index });
    const rep = learningReport(ctx.db, { T });
    assert.equal(rep.by_source.implicit, 3);
    assert.equal(rep.by_source.correction, 2);
    assert.equal(rep.by_source.user, 1);
    assert.equal(rep.outcomes.suggest_confirmed, 3);
    assert.equal(rep.outcomes.suggest_corrected, 1);
    assert.equal(rep.outcomes.auto_corrected, 1);
    assert.equal(rep.outcomes.auto_kept, 1);
    assert.equal(rep.rates.auto_precision, 0.5);
    assert.equal(rep.implicit.kept, 3);
    assert.deepEqual(rep.top_reason, { key: "titleAuto", count: 3, threshold: T.titleAuto });
    const title = rep.metrics.find((m) => m.key === "title");
    assert.equal(title.value, T.titleAuto);
    assert.equal(title.bins.reduce((a, b) => a + b.confirmed, 0), 3);
    assert.equal(title.bins.reduce((a, b) => a + b.wrong, 0), 2);
    assert.deepEqual(title.relax, { value: 0.7, gained: 3, wrong_passing: 0 });
    assert.equal(rep.enough_data, false);
  });
});

// ---------------------------------------------------------------------------
// HTTP

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// the real fetch (the lib tests' beforeEach stubs Scryfall's)
const realFetch = globalThis.fetch;
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

describe("HTTP learning + export", () => {
  let dir, proc, base, ids;
  const get = async (p) => {
    const res = await realFetch(base + p);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-learn-api-"));
    const dbFile = path.join(dir, "app.db");
    const db = openDb(dbFile);
    seedCards(db);
    const a = stageScan(db, suggest(BOLT, { title: 0.7 }), { imageDir: dir, session: "s1" }).scan;
    const b = stageScan(db, result(SOL), { imageDir: dir, session: "s1" }).scan;
    ids = { a: a.id, b: b.id };
    db.close();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(port), DB_FILE: dbFile, INDEX_DB_FILE: path.join(dir, "index.db"), STATIC_DIR: path.join(ROOT, "public"),
        SCAN_IMAGE_DIR: path.join(dir, "scans"), DEBUG_SESSIONS_DIR: path.join(dir, "debug"), BACKUP_DIR: path.join(dir, "bk"),
        SCAN_AUTO_INDEX: "false", SCHEDULER_ENABLED: "false", APP_VERSION: "9.9.9-test", CLAUDE_CLI_INSTALL: "false", SPELLBOOK_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout.on("data", (d) => { log += d; });
    proc.stderr.on("data", (d) => { log += d; });
    const deadline = Date.now() + 20000;
    for (;;) {
      try { if ((await realFetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
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

  test("GET /api/scans/learning", async () => {
    const r = await get("/api/scans/learning");
    assert.equal(r.status, 200);
    assert.equal(r.body.by_source.implicit, 1);
    assert.equal(r.body.outcomes.suggest_confirmed, 1);
    assert.equal(r.body.top_reason.key, "titleAuto");
    assert.ok(Array.isArray(r.body.metrics) && r.body.metrics.length === LEARNING_METRICS.length);
  });

  test("GET /api/calibration/export?source= filters; unknown sources are 400; rows carry the source", async () => {
    const all = await get("/api/calibration/export");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.scans.map((s) => [s.id, s.source]), [[ids.a, "implicit"]]);
    assert.equal((await get("/api/calibration/export?source=implicit,user")).body.scans.length, 1);
    assert.equal((await get("/api/calibration/export?source=calibration")).body.scans.length, 0);
    const bad = await get("/api/calibration/export?source=nope");
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /source/);
    assert.equal((await get(`/api/scans/${ids.a}`)).body.match_status, "confirmed");
  });
});
