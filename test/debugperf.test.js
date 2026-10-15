// Scanner perf beacon store (lib/debugperf.js): validation, the ring buffer
// file (newest `max` kept), list order. Offline, temp dir.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebugPerf, PERF_LIMITS, PerfError, sanitizePerf } from "../lib/debugperf.js";

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "mtg-planner-test-perf-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const status = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PerfError, e.message); return e.status; } return 0; };

describe("sanitizePerf", () => {
  test("keeps known keys, drops unknown ones, rounds numbers, nulls non-finite ones, cuts strings", () => {
    const out = sanitizePerf({
      ua: "x".repeat(1000), video: { w: 2160, h: 3840, fps: 29.97003, junk: () => 1 }, analyze: { p50: 12.34567, max: Infinity },
      worker: true, evil: "drop me", __proto__: { polluted: 1 }, grab_mode: { mode: "gpu", "bad key!": 1 },
    });
    assert.equal(out.ua.length, PERF_LIMITS.string);
    assert.deepEqual(out.video, { w: 2160, h: 3840, fps: 29.97 });
    assert.deepEqual(out.analyze, { p50: 12.346, max: null });
    assert.equal(out.worker, true);
    assert.equal("evil" in out, false);
    assert.deepEqual(out.grab_mode, { mode: "gpu" });
    assert.equal(({}).polluted, undefined);
  });

  test("keeps the frame-path fields (where the camera frame is read, worker timings, the 1080p drop)", () => {
    const out = sanitizePerf({
      frame_path: "track", wgrab: { n: 3, p50: 12 }, wsharp: { n: 3, p50: 8 }, probe_crop: { n: 1, p50: 40 },
      res: { from: [2160, 3840], cost: 450, at: 1, ok: true },
    });
    assert.equal(out.frame_path, "track");
    assert.deepEqual(out.wgrab, { n: 3, p50: 12 });
    assert.deepEqual(out.res.from, [2160, 3840]);
    assert.equal(out.probe_crop.p50, 40);
    assert.equal(out.wsharp.p50, 8);
  });

  test("keeps the analysis clone's report (grab_mode.clone, flat) and the probe read/job series", () => {
    const clone = { state: "ready", w: 480, h: 853, ask_w: 480, ask_h: 853, set_w: 480, set_h: 853, resize: "crop-and-scale", ow0: 2160, oh0: 3840, ow1: 2160, oh1: 3840, setup_ms: 42.5, frames: 120 };
    const out = sanitizePerf({
      frame_path: "clone", grab_mode: { path: "clone", why: null, mode: "cpu", clone },
      probe_read: { n: 2, p50: 240 }, probe_job: { n: 2, p50: 90 },
    });
    assert.deepEqual(out.grab_mode.clone, clone);
    assert.equal(out.probe_read.p50, 240);
    assert.equal(out.probe_job.p50, 90);
  });

  test("nesting deeper than 3 levels and long arrays are cut; 400 for non-objects or nothing known; 413 when too large", () => {
    const out = sanitizePerf({ video: { a: { b: { c: 1 } } }, screen: { list: Array.from({ length: 40 }, (_, i) => i) } });
    assert.deepEqual(out.video, { a: {} });
    assert.equal(out.screen.list.length, PERF_LIMITS.array, "arrays are cut to 16 items");
    const deep = sanitizePerf({ screen: { a: [[1], 2] } });
    assert.deepEqual(deep.screen, { a: [2] }, "an array inside an array (depth 3) is dropped");
    for (const bad of [null, [], "x", 5, { nothing: 1 }]) assert.equal(status(() => sanitizePerf(bad)), 400, JSON.stringify(bad));
    const big = {};
    for (let i = 0; i < 40; i++) big[`k${i}`] = "y".repeat(290);
    assert.equal(status(() => sanitizePerf({ video: big })), 413);
  });
});

describe("DebugPerf", () => {
  test("appends JSON lines with `at`; list is newest first and limited", async () => {
    const file = path.join(dir, "sub", "debug-perf.jsonl");
    const p = new DebugPerf({ file });
    for (let i = 0; i < 5; i++) await p.add({ gap: i, ua: "phone" }, { now: Date.parse("2026-10-15T10:00:00Z") + i * 5000 });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 5);
    assert.equal(lines[0].at, "2026-10-15T10:00:00.000Z");
    const list = await p.list({ limit: 3 });
    assert.deepEqual(list.map((e) => e.gap), [4, 3, 2]);
    // a fresh instance reads the same file
    assert.deepEqual((await new DebugPerf({ file }).list()).map((e) => e.gap), [4, 3, 2, 1, 0]);
  });

  test("keeps the newest `max` entries: the file is compacted once it holds 20 % more", async () => {
    const file = path.join(dir, "debug-perf.jsonl");
    const p = new DebugPerf({ file, max: 10 });
    for (let i = 0; i < 12; i++) await p.add({ gap: i });
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 12, "12 = 1.2 * max: not yet");
    await p.add({ gap: 12 });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((e) => e.gap), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 13; i < 40; i++) await p.add({ gap: i });
    const all = await p.list({ limit: 1000 });
    assert.ok(all.length <= 12 && all.length >= 10, String(all.length));
    assert.equal(all[0].gap, 39);
  });

  test("a torn line is skipped; a missing file lists nothing; an invalid beacon writes nothing", async () => {
    const file = path.join(dir, "debug-perf.jsonl");
    writeFileSync(file, '{"at":"x","gap":1}\n{"at":"y","ga\n');
    const p = new DebugPerf({ file });
    assert.deepEqual((await p.list()).map((e) => e.gap), [1]);
    const q = new DebugPerf({ file: path.join(dir, "none.jsonl") });
    assert.deepEqual(await q.list(), []);
    await assert.rejects(q.add({ nothing: 1 }), (e) => e.status === 400);
    assert.equal(existsSync(path.join(dir, "none.jsonl")), false);
  });
});
