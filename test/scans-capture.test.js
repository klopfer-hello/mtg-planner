// Capture-controller logging in the staging list (lib/scans.js, v0.5.0):
// the capture record whitelist, the dup_of duplicate rule (outside the window,
// any match_status), the /increment capture event and its undo, the ring
// buffer of dropped records, and captureLog. Offline, stub printings.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAPTURE_EVENTS_MAX, CAPTURE_MAX_BYTES, captureLog, commitScans, getScan, incrementScan, sanitizeCapture, stageScan, undoLast,
} from "../lib/scans.js";
import { ID, SCRYFALL_CARDS, seedCards, stubScryfall, tempDb } from "./fixtures.js";

const fx = (id) => SCRYFALL_CARDS.find((c) => c.id === id);
const asPrinting = (c, extra = {}) => ({
  id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: null, lang: c.lang, set_code: c.set, set_name: c.set_name,
  collector_number: c.collector_number, rarity: c.rarity, finishes: ["nonfoil", "foil"], faces: [], type_line: c.type_line,
  mana_cost: c.mana_cost, ...extra,
});
const BOLT = asPrinting(fx(ID.lightning));
const SOL = asPrinting(fx(ID.sol));
const result = (printing, o = {}) => ({
  status: "auto", printing, store: o.store ?? printing, finish: "normal", finishSource: "star", method: "ocr", confidence: 0.95,
  candidates: [], variants: [], features: { collector: { raw: "x" } }, timings: { total: 5 }, ...o,
});
const REC = {
  kind: "new", d: 0.2345678, d_cap: null, armed: ["motion", "card"], watch: false, fallback: false, quad_source: "track", mad: 3.21,
  sharp: 140, variants: 27, calibration: false, allow_claude: true, evidence: { card: true, empty: false, weak: 3, d_empty: 9.5, d_top: null },
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
      ...REC, secret: "x", html: "<script>", kind: "new", quad_source: "bad value with spaces", sharp: "140", watch: "yes",
      armed: ["motion", 42, "card", "x".repeat(40)], watch_checks: [0.1, "a", 0.123456789, Infinity],
      evidence: { card: true, weak: 3, extra: 1 }, pending: "nope", chip: { label: "same", d: 0.05, calibration: false, nested: { a: 1 } },
    });
    assert.equal(c.d, 0.2346);
    assert.equal(c.kind, "new");
    assert.equal(c.secret, undefined);
    assert.equal(c.html, undefined);
    assert.equal(c.quad_source, undefined, "an enum must be a short token");
    assert.equal(c.sharp, undefined, "a number as string is dropped");
    assert.equal(c.watch, undefined);
    assert.deepEqual(c.armed, ["motion", "card"]);
    assert.deepEqual(c.watch_checks, [0.1, 0.1235]);
    assert.deepEqual(c.evidence, { card: true, weak: 3 });
    assert.equal(c.pending, undefined);
    assert.deepEqual(c.chip, { label: "same", d: 0.05, calibration: false });
    assert.equal(c.d_cap, null, "null is kept");
  });

  test("non-objects give null; prev[] keeps the newest 10, without nesting", () => {
    assert.equal(sanitizeCapture(null), null);
    assert.equal(sanitizeCapture([REC]), null);
    assert.equal(sanitizeCapture("x"), null);
    const prev = Array.from({ length: 15 }, (_, i) => ({ kind: "silent", d: i / 100, prev: [{ kind: "deep" }], junk: 1 }));
    const c = sanitizeCapture({ ...REC, prev });
    assert.equal(c.prev.length, 10);
    assert.equal(c.prev[0].d, 0.05, "oldest dropped first");
    assert.equal(c.prev[9].d, 0.14);
    assert.ok(c.prev.every((p) => p.prev === undefined && p.junk === undefined));
  });

  test("at most 4 KB: older prev entries go first", () => {
    const big = { ...REC, armed: Array(12).fill("abcdefghijklmnopqrstuvwxyz012345"), evidence: REC.evidence };
    const c = sanitizeCapture({ ...big, prev: Array.from({ length: 10 }, (_, i) => ({ ...big, d: i })) });
    assert.ok(Buffer.byteLength(JSON.stringify(c)) <= CAPTURE_MAX_BYTES);
    assert.ok(c.prev.length < 10 && c.prev.length > 0);
    assert.equal(c.prev.at(-1).d, 9, "the newest prev entry survives");
  });
});

describe("capture record on staging", () => {
  test("merged into features.capture next to the identify features", () => {
    const { scan } = stage(result(BOLT), { capture: { ...REC, bogus: 1 } });
    const f = features(scan.id);
    assert.equal(f.capture.kind, "new");
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
});

describe("dup_of", () => {
  test("same stored printing and finish as a still-staged row: duplicate, outside the window", () => {
    const a = stage(result(BOLT), { now: Date.parse("2026-10-14T10:00:00Z") }).scan;
    stage(result(SOL), { now: Date.parse("2026-10-14T10:00:01Z") });
    const later = Date.parse("2026-10-14T11:00:00Z"); // an hour later, another scan in between
    const r = stage(result(BOLT), { dupOf: a.id, now: later, capture: { ...REC, kind: "chip", chip: { label: "ignored", d: 0.06 } } });
    assert.equal(r.duplicate, true);
    assert.equal(r.scan.id, a.id);
    const ev = features(a.id).capture_events;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].event, "duplicate");
    assert.equal(ev[0].rule, "dup_of");
    assert.equal(ev[0].capture.chip.label, "ignored");
    assert.equal(getScan(ctx.db, a.id).quantity, 1, "the server asks; nothing is counted");
  });

  test("a foil copy of a non-foil row is not a duplicate: staged as its own row", () => {
    const a = stage(result(BOLT)).scan;
    const r = stage(result(BOLT, { finish: "foil" }), { dupOf: a.id, now: Date.now() + 3600_000 });
    assert.equal(r.duplicate, false);
    assert.notEqual(r.scan.id, a.id);
    assert.equal(r.scan.finish, "foil");
  });

  test("ignores match_status mixes: an auto row matches a later suggest result", () => {
    const a = stage(result(BOLT)).scan;
    const r = stage(result(BOLT, { status: "suggest" }), { dupOf: a.id, now: Date.now() + 3600_000 });
    assert.equal(r.duplicate, true);
  });

  test("review: same detected printing", () => {
    const a = stage(result(BOLT, { status: "review" })).scan;
    stage(result(SOL));
    const r = stage(result(BOLT, { status: "review" }), { dupOf: a.id, now: Date.now() + 3600_000 });
    assert.equal(r.duplicate, true);
    assert.equal(r.scan.id, a.id);
  });

  test("a different card, a committed or missing row, or force: staged as usual", async () => {
    const a = stage(result(BOLT)).scan;
    const other = stage(result(SOL), { dupOf: a.id });
    assert.equal(other.duplicate, false);
    assert.equal(features(other.scan.id).dup_of, a.id);
    const forced = stage(result(BOLT), { dupOf: a.id, force: true });
    assert.equal(forced.duplicate, false);
    const gone = stage(result(SOL), { dupOf: 9999, now: Date.now() + 3600_000 });
    assert.equal(gone.duplicate, false);
    await commitScans(ctx.db, [a.id], { type: "binder", name: "Box", create: true }, { idx: {}, index: { getPrinting: () => null }, imageDir });
    const after = stage(result(BOLT), { dupOf: a.id, now: Date.now() + 7200_000 });
    assert.equal(after.duplicate, false, "a committed row is no longer a duplicate target");
  });

  test("without dup_of the 20 s window rule still applies (and logs the capture on the row)", () => {
    const now = Date.now();
    const a = stage(result(BOLT), { now }).scan;
    const r = stage(result(BOLT), { now: now + 1000, capture: REC });
    assert.equal(r.duplicate, true);
    assert.equal(features(a.id).capture_events[0].rule, "window");
  });
});

describe("increment capture events", () => {
  test("appended with the quantity; undo of that +1 drops it; capped at 20", () => {
    const a = stage(result(BOLT)).scan;
    incrementScan(ctx.db, a.id, { capture: { ...REC, kind: "chip", chip: { label: "same", d: 0.05 } } });
    incrementScan(ctx.db, a.id); // a +1 without a record
    incrementScan(ctx.db, a.id, { capture: { kind: "chip" } });
    let ev = features(a.id).capture_events;
    assert.deepEqual(ev.map((e) => [e.event, e.q]), [["increment", 2], ["increment", 4]]);
    assert.equal(ev[0].capture.chip.label, "same");

    assert.equal(undoLast(ctx.db, { imageDir }).undone, "decrement"); // 4 -> 3
    ev = features(a.id).capture_events;
    assert.deepEqual(ev.map((e) => e.q), [2]);
    undoLast(ctx.db, { imageDir }); // 3 -> 2: the record-less +1
    assert.deepEqual(features(a.id).capture_events.map((e) => e.q), [2]);
    undoLast(ctx.db, { imageDir }); // 2 -> 1
    assert.deepEqual(features(a.id).capture_events, []);

    for (let i = 0; i < 25; i++) incrementScan(ctx.db, a.id, { capture: { kind: "chip", d: i } });
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
    incrementScan(ctx.db, b.id, { capture: { kind: "chip" } });
    stage(result(BOLT, { store: BOLT }), { force: true }); // no record, no events
    await commitScans(ctx.db, [a.id], { type: "binder", name: "Box", create: true }, { idx: {}, index: { getPrinting: () => null }, imageDir });
    const log = captureLog(ctx.db);
    assert.deepEqual(log.scans.map((s) => [s.id, s.status]), [[a.id, "committed"], [b.id, "staged"]]);
    assert.equal(log.scans[0].capture.kind, "new");
    assert.equal(log.scans[1].capture, null);
    assert.equal(log.scans[1].capture_events.length, 1);
    assert.deepEqual(log.dropped, []);
  });
});
