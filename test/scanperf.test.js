// Scanner frame pacing and perf beacon helpers (public/scanperf.js): pure,
// no DOM.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FramePacer, PACER_DEFAULTS, PerfMonitor, percentile, summarize } from "../public/scanperf.js";

describe("percentile / summarize", () => {
  test("nearest rank; non-finite values ignored; empty → null", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([4, 1, 3, 2, NaN, Infinity], 0.9), 4);
    assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 90);
    assert.deepEqual(summarize([]), { n: 0, p50: null, p90: null, max: null });
    assert.deepEqual(summarize([1.04, 2.26, 3, null]), { n: 3, p50: 2.3, p90: 3, max: 3 });
  });
});

describe("FramePacer", () => {
  test("starts at the minimum gap (8 Hz) and keeps it while frames are cheap", () => {
    const p = new FramePacer();
    assert.equal(p.gap(), PACER_DEFAULTS.minGapMs);
    for (let i = 0; i < 20; i++) p.note(20);
    assert.equal(p.gap(), 125, "20 ms of main thread per frame fits 8 Hz at a 45 % budget");
  });

  test("a slow phone backs off so the analysis stays under the budget, capped at maxGapMs", () => {
    const p = new FramePacer();
    for (let i = 0; i < 40; i++) p.note(100);
    assert.equal(p.gap(), Math.round(100 / PACER_DEFAULTS.budget));
    for (let i = 0; i < 40; i++) p.note(1000);
    assert.equal(p.gap(), PACER_DEFAULTS.maxGapMs);
    assert.ok(p.due(1000, 1000 - PACER_DEFAULTS.maxGapMs));
    assert.ok(!p.due(1000, 1000 - PACER_DEFAULTS.maxGapMs + 1));
  });

  test("one slow frame moves the gap only a little; it recovers when frames get cheap again", () => {
    const p = new FramePacer();
    for (let i = 0; i < 10; i++) p.note(30);
    p.note(600); // a GC pause or a probe crop
    assert.ok(p.gap() < 400, String(p.gap()));
    for (let i = 0; i < 30; i++) p.note(20);
    assert.equal(p.gap(), 125);
  });

  test("ignores invalid samples; config overrides", () => {
    const p = new FramePacer({ minGapMs: 100, maxGapMs: 300, budget: 0.5 });
    p.note(NaN); p.note(-5); p.note(undefined);
    assert.equal(p.ewma, null);
    p.note(100);
    assert.equal(p.gap(), 200);
  });
});

describe("PerfMonitor", () => {
  test("snapshot summarizes the window, merges extra fields and starts a new window", () => {
    const m = new PerfMonitor({ now: 0 });
    for (let i = 1; i <= 10; i++) m.frame({ total: i * 10, main: i, grab: 2, detect: 5, sharp: 1 });
    [100, 120, 140].forEach((v) => m.interval(v));
    [16, 17, 50].forEach((v) => m.raf(v));
    m.longTask(80); m.longTask(120); m.longTask(NaN);
    m.probe({ rtt: 400, capture: 90 }); m.probe({ rtt: 600, capture: 110 }); m.probe({ error: true });
    assert.equal(m.frames, 10);
    const b = m.snapshot(5000, { ua: "x", video: { w: 2160, h: 3840 } });
    assert.equal(b.v, 1);
    assert.equal(b.window_ms, 5000);
    assert.deepEqual(b.analyze, { n: 10, p50: 50, p90: 90, max: 100 });
    assert.equal(b.main.max, 10);
    assert.deepEqual(b.interval, { n: 3, p50: 120, p95: 140, max: 140 });
    assert.equal(b.raf.p95, 50);
    assert.equal(b.long_tasks, 2);
    assert.equal(b.long_task_ms, 200);
    assert.equal(b.probes, 3);
    assert.equal(b.errors, 1);
    assert.deepEqual(b.probe_rtt, { n: 2, p50: 400, p90: 600, max: 600 });
    assert.equal(b.probe_capture.p50, 90);
    assert.equal(b.ua, "x");
    assert.deepEqual(b.video, { w: 2160, h: 3840 });
    const next = m.snapshot(6000);
    assert.equal(next.window_ms, 1000);
    assert.equal(next.analyze.n, 0);
    assert.equal(next.long_tasks, 0);
    assert.equal(next.probes, 0);
  });

  test("a series keeps at most 600 samples", () => {
    const m = new PerfMonitor({ now: 0 });
    for (let i = 0; i < 1000; i++) m.raf(i);
    const b = m.snapshot(1);
    assert.equal(b.raf.n, 600);
    assert.equal(b.raf.max, 999);
  });
});
