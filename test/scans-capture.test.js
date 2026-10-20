// Capture-controller logging in the staging list (lib/scans.js, v0.5.0):
// the capture record whitelist, the /increment capture event and its undo,
// the ring buffer of dropped records, and captureLog. Offline, stub printings.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPTURE_EVENTS_MAX, captureLog, sanitizeCapture } from "../lib/scancapture.js";
import { commitScans } from "../lib/scancommit.js";
import { getScan } from "../lib/scanrow.js";
import { incrementScan, stageScan, undoLast } from "../lib/scans.js";
import { ID, SCRYFALL_CARDS, seedCards, stubScryfall, tempDb } from "./fixtures.js";
import { asPrinting } from "./helpers/scan.js";

const fx = (id) => SCRYFALL_CARDS.find((c) => c.id === id);
const BOLT = asPrinting(fx(ID.lightning));
const SOL = asPrinting(fx(ID.sol));
const result = (printing, o = {}) => ({
  status: "auto", printing, store: o.store ?? printing, finish: "normal", finishSource: "star", method: "ocr", confidence: 0.95,
  candidates: [], variants: [], features: { collector: { raw: "x" } }, timings: { total: 5 }, ...o,
});
const REC = {
  kind: "manual", d: 0.2345678, fallback: false, quad_source: "track", mad: 3.21, sharp: 140, variants: 27, calibration: false,
  allow_claude: true, det: "v2", shot: "video", t: 1760000000000,
};

let ctx, imageDir, stub;
beforeEach(() => {
  ctx = tempDb();
  seedCards(ctx.db);
  imageDir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-img-"));
  stub = stubScryfall();
});
afterEach(() => {
  stub.restore();
  ctx.cleanup();
  rmSync(imageDir, { recursive: true, force: true });
});
const stage = (r, o = {}) => stageScan(ctx.db, r, { imageDir, ...o });
const features = (id) => getScan(ctx.db, id, { features: true }).features;

describe("sanitizeCapture", () => {
  test("keeps whitelisted fields, rounds numbers, drops unknown keys and wrong types", () => {
    const c = sanitizeCapture({
      ...REC, secret: "x", html: "<script>", kind: "probe", quad_source: "bad value with spaces", sharp: "140", fallback: "yes",
      prev: [{ kind: "silent" }], chip: { label: "same" }, dup_of: 3, armed: ["motion"], jitter: null,
    });
    assert.equal(c.d, 0.2346);
    assert.equal(c.kind, "probe");
    assert.equal(c.secret, undefined);
    assert.equal(c.html, undefined);
    assert.equal(c.quad_source, undefined, "an enum must be a short token");
    assert.equal(c.sharp, undefined, "a number as string is dropped");
    assert.equal(c.fallback, undefined);
    assert.equal(c.jitter, null, "null is kept");
    for (const k of ["prev", "chip", "dup_of", "armed"]) assert.equal(c[k], undefined, `${k}: no current client sends it`);
  });

  test("non-objects give null", () => {
    assert.equal(sanitizeCapture(null), null);
    assert.equal(sanitizeCapture([REC]), null);
    assert.equal(sanitizeCapture("x"), null);
  });
});

describe("capture record on staging", () => {
  test("merged into features.capture next to the identify features", () => {
    const { scan } = stage(result(BOLT), { capture: { ...REC, bogus: 1 } });
    const f = features(scan.id);
    assert.equal(f.capture.kind, "manual");
    assert.equal(f.capture.bogus, undefined);
    assert.equal(f.collector.raw, "x");
    assert.equal(f.result.status, "auto");
  });

  test("a failed (unstaged) capture lands in the dropped ring buffer", () => {
    const r = stage({ status: "failed", printing: null }, { capture: { ...REC, fallback: true, quad_source: "default" } });
    assert.equal(r.scan, null);
    const log = captureLog(ctx.db);
    assert.equal(log.dropped.length, 1);
    assert.equal(log.dropped[0].reason, "failed");
    assert.equal(log.dropped[0].capture.quad_source, "default");
  });

  test("a duplicate within the 20 s window logs the capture on the repeated row", () => {
    const now = Date.now();
    const a = stage(result(BOLT), { now }).scan;
    const r = stage(result(BOLT), { now: now + 1000, capture: REC });
    assert.equal(r.duplicate, true);
    assert.equal(features(a.id).capture_events[0].rule, "window");
  });

  test("a legacy dup_of option is ignored: staged as its own row", () => {
    const a = stage(result(BOLT), { now: Date.parse("2026-10-14T10:00:00Z") }).scan;
    const r = stage(result(BOLT), { dupOf: a.id, now: Date.parse("2026-10-14T11:00:00Z") });
    assert.equal(r.duplicate, false);
    assert.equal(features(r.scan.id).dup_of, undefined);
  });
});

describe("increment capture events", () => {
  test("appended with the quantity; undo of that +1 drops it; capped at 20", () => {
    const a = stage(result(BOLT)).scan;
    incrementScan(ctx.db, a.id, { capture: { ...REC, kind: "manual", d: 0.05 } });
    incrementScan(ctx.db, a.id); // a +1 without a record
    incrementScan(ctx.db, a.id, { capture: { kind: "manual" } });
    let ev = features(a.id).capture_events;
    assert.deepEqual(ev.map((e) => [e.event, e.q]), [["increment", 2], ["increment", 4]]);
    assert.equal(ev[0].capture.d, 0.05);

    assert.equal(undoLast(ctx.db, { imageDir }).undone, "decrement"); // 4 -> 3
    ev = features(a.id).capture_events;
    assert.deepEqual(ev.map((e) => e.q), [2]);
    undoLast(ctx.db, { imageDir }); // 3 -> 2: the record-less +1
    assert.deepEqual(features(a.id).capture_events.map((e) => e.q), [2]);
    undoLast(ctx.db, { imageDir }); // 2 -> 1
    assert.deepEqual(features(a.id).capture_events, []);

    for (let i = 0; i < 25; i++) incrementScan(ctx.db, a.id, { capture: { kind: "manual", d: i } });
    ev = features(a.id).capture_events;
    assert.equal(ev.length, CAPTURE_EVENTS_MAX);
    assert.equal(ev.at(-1).capture.d, 24);
  });

  test("undoing a staged scan keeps its capture record in the dropped ring buffer", () => {
    const a = stage(result(BOLT), { capture: REC }).scan;
    assert.equal(undoLast(ctx.db, { imageDir }).undone, "delete");
    const log = captureLog(ctx.db);
    assert.equal(log.scans.length, 0);
    assert.equal(log.dropped.length, 1);
    assert.equal(log.dropped[0].reason, "undo");
    assert.equal(log.dropped[0].scan_id, a.id);
    assert.equal(log.dropped[0].capture.d, 0.2346);
  });
});

describe("captureLog", () => {
  test("staged and committed scans with a record or events; scans without are left out", async () => {
    const a = stage(result(BOLT), { capture: REC }).scan;
    const b = stage(result(SOL)).scan; // no record
    incrementScan(ctx.db, b.id, { capture: { kind: "manual" } });
    stage(result(BOLT, { store: BOLT }), { force: true }); // no record, no events
    await commitScans(ctx.db, [a.id], { type: "binder", name: "Box", create: true }, { idx: {}, index: { getPrinting: () => null }, imageDir });
    const log = captureLog(ctx.db);
    assert.deepEqual(log.scans.map((s) => [s.id, s.status]), [[a.id, "committed"], [b.id, "staged"]]);
    assert.equal(log.scans[0].capture.kind, "manual");
    assert.equal(log.scans[1].capture, null);
    assert.equal(log.scans[1].capture_events.length, 1);
    assert.deepEqual(log.dropped, []);
  });
});
